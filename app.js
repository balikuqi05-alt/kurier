'use strict';
/* Kurier – persönliche Liefer-App für Subito Pizzakurier (Landquart).
   Alle Daten bleiben im Speicher dieses Handys (localStorage).
   Ins Internet gehen nur: Adresse → Kartenpunkt (OpenStreetMap/Nominatim),
   Routenberechnung (OSRM), Kartenbilder (OpenStreetMap), Texterkennungs-Programm (einmal laden). */

// ---------- Grunddaten Subito ----------
const SUBITO = {
  name: 'Subito Pizzakurier',
  street: 'Kantonstrasse 24', plz: '7302', ort: 'Landquart',
  phone: '0813222020'
};
// Mindestbestellwert pro Ort (laut subitopizzakurier.ch)
const ORTE = {
  'Landquart': 20, 'Landquart Fabriken': 20, 'Zizers': 20, 'Igis': 20, 'Malans': 20,
  'Seewis Pardisla': 20, 'Seewis-Schmitten': 20, 'Grüsch': 20, 'Mastrils': 20, 'Maienfeld': 20,
  'Jenins': 20, 'Trimmis': 20, 'Untervaz': 20, 'Schiers': 20, 'Fläsch': 20, 'Bad Ragaz': 20,
  'Seewis Dorf': 30, 'Fanas': 30, 'Pfäfers': 30,
  'Valzeina': 50, 'Pragg-Jenaz': 50, 'Jenaz': 50, 'Valens': 50,
  'Chur': 70, 'Fideris': 90, 'Sargans': 90, 'Küblis': 100
};
const TAGS = ['Klingel kaputt – anrufen', 'Hintereingang', 'Hund', 'Viele Treppen', 'Kein Lift',
  'Name nicht angeschrieben', 'Gutes Trinkgeld', 'Zahlt mit Karte', 'Schwer zu finden', 'Parkieren schwierig'];

// ---------- Helfer ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fr = n => (Math.round((+n || 0) * 100) / 100).toFixed(2);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const dt = t => new Date(t).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
const tm = t => new Date(t).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Speicher ----------
const KEY = 'kurier.v1';
const EMPTY = {
  settings: { base: null, roundtrip: true, navApp: 'google', startFromGps: false, lastOrt: 'Landquart' },
  customers: {}, tour: [], shifts: [], activeShift: null
};
let db = loadDb();
function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) return { ...structuredClone(EMPTY), ...d, settings: { ...EMPTY.settings, ...(d.settings || {}) } };
  } catch (e) { /* leer starten */ }
  return structuredClone(EMPTY);
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('⚠️ Speichern fehlgeschlagen'); }
}

// ---------- Adressen & Kunden ----------
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/strasse\b/g, 'str').replace(/str\./g, 'str')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const custKey = (street, ort) => norm(street) + '|' + norm(ort);
const addrLine = c => `${c.street}, ${c.plz ? c.plz + ' ' : ''}${c.ort}`;
function findCustomer(street, ort) {
  if (!street) return null;
  const k = custKey(street, ort);
  if (db.customers[k]) return db.customers[k];
  const s = norm(street);
  return Object.values(db.customers).find(c => norm(c.street) === s) || null;
}
function upsertCustomer({ street, plz, ort, phone, name }) {
  let c = findCustomer(street, ort);
  if (!c) {
    const id = custKey(street, ort);
    c = db.customers[id] = { id, name: name || '', street, plz: plz || '', ort, phone: phone || '', lat: null, lng: null,
      park: null, bell: null, notes: '', tags: [], visits: [], created: Date.now() };
  } else {
    if (phone) c.phone = phone;
    if (name) c.name = name;
    if (plz && !c.plz) c.plz = plz;
  }
  return c;
}
const target = c => c && (c.park || (c.lat != null ? { lat: c.lat, lng: c.lng } : null));
const doorPoint = c => c && (c.bell || (c.lat != null ? { lat: c.lat, lng: c.lng } : null));
function custStats(c) {
  const v = c.visits || [];
  const tips = v.map(x => +x.tip || 0);
  return { n: v.length, avgTip: tips.length ? tips.reduce((a, b) => a + b, 0) / tips.length : 0, last: v.length ? v[v.length - 1].t : null };
}

// ---------- Internet-Dienste (gratis, ohne Schlüssel) ----------
let lastGeo = 0;
async function nominatim(params) {
  const wait = 1100 - (Date.now() - lastGeo); // Regel von OpenStreetMap: max. 1 Anfrage pro Sekunde
  if (wait > 0) await sleep(wait);
  lastGeo = Date.now();
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=de&${params}`);
  if (!r.ok) throw new Error('Adresssuche nicht erreichbar');
  const j = await r.json();
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}
// Sucht die Adresse in mehreren Varianten (Schreibfehler wie Kantonstrasse/Kantonsstrasse).
// Ergebnis {lat,lng,approx}: approx = nur Strasse oder nur Ort gefunden → Punkt prüfen.
async function geocode(street, plz, ort) {
  const town = ort.replace(/ (Dorf|Pardisla|Fabriken)$/, '').replace(/^Seewis-Schmitten$/, 'Seewis im Prättigau');
  const place = [plz, town].filter(Boolean).join(' ');
  const variants = [...new Set([street,
    street.replace(/([a-zäöü])strasse/i, '$1sstrasse'),
    street.replace(/([a-zäöü])sstrasse/i, '$1strasse'),
    street.replace(/str\.?(\s)/i, 'strasse$1')])].filter(Boolean);
  const tries = [];
  variants.forEach(v => tries.push([`q=${enc(v + ', ' + place)}&countrycodes=ch`, false]));
  if (street) tries.push([`q=${enc(street.replace(/\s+\d+\s?[a-z]?$/i, '') + ', ' + place)}&countrycodes=ch`, true]);
  tries.push([`q=${enc(place)}&countrycodes=ch`, true]);
  for (const [t, approx] of tries) {
    try { const p = await nominatim(t); if (p) return { ...p, approx }; } catch (e) { /* nächster Versuch */ }
  }
  return null;
}
function gps() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Kein GPS'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(e), { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  });
}
function navUrl(p) {
  const ll = `${p.lat},${p.lng}`;
  if (db.settings.navApp === 'apple') return `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
  if (db.settings.navApp === 'waze') return `https://waze.com/ul?ll=${ll}&navigate=yes`;
  return `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
}

// ---------- Texterkennung (gratis, läuft auf dem Handy) ----------
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Laden fehlgeschlagen')); document.head.appendChild(s); });
}
async function ocr(file, onStatus) {
  if (!window.Tesseract) { onStatus('Lade Texterkennung (nur beim ersten Mal)…'); await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'); }
  let img = file;
  try { img = await prepImage(file); } catch (e) { /* Originalbild verwenden */ }
  onStatus('Lese Zettel…');
  const worker = await Tesseract.createWorker('deu');
  try { const { data } = await worker.recognize(img); return data.text || ''; }
  finally { await worker.terminate(); }
}
// Foto verkleinern, in Graustufen umwandeln und Kontrast strecken (dunkle Fotos im Auto!)
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  const hist = new Uint32Array(256), lum = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; lum[j] = v; hist[v]++; }
  const n = lum.length; let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = Math.max(0, Math.min(255, (lum[j] - lo) * 255 / span)); d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(im, 0, 0);
  return c;
}

// Liest Bestellzettel (Subito-Zettel, WhatsApp-Text, andere Zettel).
// Die eigene Subito-Adresse/Telefonnummer im Kopf des Zettels wird ignoriert.
const SUBITO_LINE = /subito|pizzakurier|center\s*au|kantons?strasse\s*24|7302\s*landquart|322\s?20\s?20|www\.|mwst|che[-\s]?\d{3}/i;
function parseOrder(text) {
  const all = text.split(/\r?\n|[,;|]/).map(l => l.trim()).filter(Boolean);
  const lines = all.filter(l => !SUBITO_LINE.test(l));
  const out = { name: '', street: '', plz: '', ort: '', phone: '', amount: '', pay: '', time: '', etage: '' };
  const phoneRe = /(?:\+41|0041|0)\s?\(?0?\)?\s?([1-9]\d)[\s./-]?(\d{3})[\s./-]?(\d{2})[\s./-]?(\d{2})\b/;
  const plzRe = /\b(\d{4})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèàç .\-]{1,30})/;
  const streetRe = /([A-Za-zÄÖÜäöüéèàç.\-' ]{3,40}?)\s+(\d{1,4}\s?[a-zA-Z]?)\b/;
  const streetWord = /(str|weg|gasse|platz|rain|halde|quai|allee|ring|hof|matt|acker|bühl|buehl|feld|via|park|berg|dorf|boden|wiese|egg|rank|zelg|gut|au)\b|strasse/i;
  const junk = /kunden.?adresse|lieferzeit|kopie|bestellung|kunde:?$/ig;
  let streetIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!out.plz) {
      const m = l.match(plzRe);
      if (m && +m[1] >= 1000 && !/\d{2}\.\d{2}\.\d{4}/.test(l)) {
        out.plz = m[1]; out.ort = m[2].trim().replace(/\s+(\d|lieferzeit).*$/i, '');
        if (!out.street && i > 0) { const p = lines[i - 1].match(streetRe); if (p && !phoneRe.test(lines[i - 1])) { out.street = `${p[1].trim()} ${p[2]}`; streetIdx = i - 1; } }
        continue;
      }
    }
    if (!out.street) { const m = l.match(streetRe); if (m && streetWord.test(m[1])) { out.street = `${m[1].trim()} ${m[2]}`; streetIdx = i; } }
    if (!out.phone) { const m = l.match(phoneRe); if (m) { out.phone = '0' + m[1] + m[2] + m[3] + m[4]; continue; } }
    if (!out.etage) { const m = l.match(/etage\s*:?\s*(-?\d+|eg|ug|og)/i); if (m) out.etage = m[1]; }
  }
  // Name = Zeile vor der Strasse (ohne „Lieferzeit“, „Kunden-Adresse“ usw.)
  if (streetIdx > 0) {
    const nm = lines[streetIdx - 1].replace(junk, '').replace(/\d{1,2}[:.]\d{2}/, '').replace(/[:\-–]+$/, '').trim()
      .split(/\s+/).filter((w, i, a) => !(w.length === 1 && i === a.length - 1)).join(' '); // OCR-Krümel am Ende weg
    if (/^[A-Za-zÄÖÜäöüéèàç.' \-]{3,40}$/.test(nm) && !streetWord.test(nm)) out.name = nm;
  }
  // Lieferzeit
  const lt = text.match(/lieferzeit\D{0,25}(\d{1,2})[:.](\d{2})/i) || text.match(/lieferdatum[^\n]*?(\d{1,2}):(\d{2})/i);
  if (lt && +lt[1] < 24) out.time = `${lt[1].padStart(2, '0')}:${lt[2]}`;
  // Bezahlt?
  if (/nichts\s*einkassieren|online\s*bezahlt|bezahlt\s*:?\s*online|bereits\s*bezahlt/i.test(text)) out.pay = 'online';
  else if (/kartenzahlung|mit\s*karte|kreditkarte|debitkarte/i.test(text)) out.pay = 'karte';
  else if (/barzahlung|\bbar\b|zu\s*bezahlen/i.test(text)) out.pay = 'bar';
  // Betrag = grösster Geldbetrag auf dem Zettel (das ist das Total)
  const nums = (lines.join('\n').match(/\d{1,4}[.,]\d{2}(?!\.\d)/g) || []).map(n => +n.replace(',', '.')).filter(n => n > 0 && n < 2000);
  if (nums.length) out.amount = fr(Math.max(...nums));
  // Ort an bekannte Liefer-Orte angleichen
  if (out.ort) { const hit = Object.keys(ORTE).find(o => norm(o) === norm(out.ort) || norm(out.ort).startsWith(norm(o))); if (hit) out.ort = hit; }
  return out;
}

// ---------- Tour ----------
const openStops = () => db.tour.filter(o => !o.done);
const doneStops = () => db.tour.filter(o => o.done);
// Route wird gespeichert, damit sie nach dem Neuladen noch da ist:
// {geo, dur, dist, seq:[orderIds], legs:[Sek. zu jedem Stopp], departAt, eta:{orderId: ms}}
let lastRoute = db.route || null;
function setRoute(r) { lastRoute = r; db.route = r; }

function hav(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearestOrder(start, stops) {
  const rest = [...stops], out = []; let cur = start;
  while (rest.length) {
    let bi = 0; rest.forEach((s, i) => { if (hav(cur, s.p) < hav(cur, rest[bi].p)) bi = i; });
    const [s] = rest.splice(bi, 1); out.push(s); cur = s.p;
  }
  return out;
}

// --- Gelerntes ---
// Übergabezeit pro Kunde (Minuten), sonst Durchschnitt aller Kunden, sonst 3 Min.
function svcMin(c) {
  const own = (c && c.svc) || [];
  if (own.length) return own.reduce((a, b) => a + b, 0) / own.length;
  const all = Object.values(db.customers).flatMap(x => x.svc || []);
  return all.length >= 3 ? all.reduce((a, b) => a + b, 0) / all.length : 3;
}
// Wie schnell du im Vergleich zur Berechnung fährst (1.0 = genau gleich, 1.2 = 20 % langsamer)
const driveFactor = () => (db.learn && db.learn.drive) || 1;
function learnDrive(actualSec, predictedSec) {
  if (!(actualSec > 60 && predictedSec > 60)) return;
  const ratio = Math.max(0.6, Math.min(1.8, actualSec / predictedSec));
  db.learn = db.learn || {};
  const old = db.learn.drive || 1, n = db.learn.driveN || 0;
  db.learn.drive = n < 5 ? (old * n + ratio) / (n + 1) : old * 0.8 + ratio * 0.2; // gleitender Mittelwert
  db.learn.driveN = n + 1;
}

// --- Routendienst OSRM (gratis) ---
const osrmCoords = pts => pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
async function osrmTable(pts) {
  const r = await fetch(`https://router.project-osrm.org/table/v1/driving/${osrmCoords(pts)}?annotations=duration`);
  const j = await r.json(); if (j.code !== 'Ok') throw new Error(j.code);
  return j.durations.map(row => row.map(v => v == null ? 1e6 : v));
}
async function osrmRoute(pts) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${osrmCoords(pts)}?overview=full&geometries=geojson`);
  const j = await r.json(); if (j.code !== 'Ok') throw new Error(j.code);
  const rt = j.routes[0];
  return { geo: rt.geometry, legs: rt.legs.map(l => l.duration), dist: rt.distance, dur: rt.duration };
}

// Beste Reihenfolge: zuerst so wenig Verspätung wie möglich, dann so wenig Fahrzeit wie möglich.
// Bis 7 Stopps werden ALLE Reihenfolgen durchgerechnet, darüber schlaue Näherung (2-opt).
function bestOrder(stops, M, depart) {
  const n = stops.length, f = driveFactor(), rt = db.settings.roundtrip;
  const cost = perm => {
    let t = depart, prev = 0, late = 0, drive = 0;
    for (const i of perm) {
      const d = M[prev][i + 1] * f * 1000; drive += d; t += d;
      if (stops[i].due && t > stops[i].due) late += t - stops[i].due;
      t += stops[i].svc * 60000; prev = i + 1;
    }
    if (rt) drive += M[prev][0] * f * 1000;
    return late * 20 + drive; // 1 Min. Verspätung zählt wie 20 Min. Umweg
  };
  let best = null, bestCost = Infinity;
  if (n <= 7) {
    const idx = [...Array(n).keys()];
    const permute = (arr, k) => {
      if (k === arr.length) { const c = cost(arr); if (c < bestCost) { bestCost = c; best = [...arr]; } return; }
      for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; permute(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
    };
    permute(idx, 0);
  } else {
    // Start: zuerst die frühesten Lieferzeiten, dann verbessern durch Umdrehen von Abschnitten
    best = [...Array(n).keys()].sort((a, b) => (stops[a].due || 9e15) - (stops[b].due || 9e15));
    bestCost = cost(best);
    for (let improved = true, loops = 0; improved && loops < 50; loops++) {
      improved = false;
      for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const c = cost(cand); if (c < bestCost) { bestCost = c; best = cand; improved = true; }
      }
    }
  }
  return best;
}

// Ankunftszeiten neu berechnen: ab „jetzt“ (oder Abfahrt) für alle noch offenen Stopps der Route
function computeEta(fromTime) {
  if (!lastRoute?.seq) return;
  const f = driveFactor(); let t = fromTime; lastRoute.eta = {};
  let started = false;
  lastRoute.seq.forEach((id, k) => {
    const o = db.tour.find(x => x.id === id);
    if (!o || o.done) return;
    // Erster offener Stopp: Fahrzeit vom letzten erledigten Stopp (bzw. Start) aus
    if (!started && o.arrivedAt) { lastRoute.eta[id] = o.arrivedAt; t = o.arrivedAt; }
    else { t += (lastRoute.legs[k] || 0) * f * 1000; lastRoute.eta[id] = t; }
    started = true;
    t += svcMin(db.customers[o.custId]) * 60000;
  });
}

async function optimizeTour() {
  const open = openStops();
  const stops = open.map(o => {
    const c = db.customers[o.custId];
    return { o, c, p: target(c), due: dueMs(o), svc: svcMin(c) };
  }).filter(s => s.p);
  const noPoint = open.filter(o => !target(db.customers[o.custId]));
  if (stops.length < 1) return toast('Es braucht mindestens 1 Adresse mit Kartenpunkt');
  let start = db.settings.base;
  if (db.settings.startFromGps) { try { start = await gps(); } catch (e) { toast('GPS nicht verfügbar – starte bei Subito'); } }
  if (!start) return toast('Zuerst unter „Mehr“ den Standort von Subito setzen');
  toast('Berechne beste Reihenfolge…', 8000);
  const depart = Date.now();
  let order;
  try {
    const M = await osrmTable([start, ...stops.map(s => s.p)]);
    order = bestOrder(stops, M, depart).map(i => stops[i]);
    const pts = [start, ...order.map(s => s.p)];
    if (db.settings.roundtrip) pts.push(start);
    const r = await osrmRoute(pts);
    setRoute({ geo: r.geo, dur: r.dur, dist: r.dist, legs: r.legs, seq: order.map(s => s.o.id), departAt: depart, eta: {} });
    order.forEach(s => { delete s.o.arrivedAt; delete s.o.arrivePos; });
    computeEta(depart);
    const late = order.filter(s => lateBy(s.o) > 0).length;
    toast(`Beste Reihenfolge: ca. ${Math.round(r.dur * driveFactor() / 60)} Min, ${(r.dist / 1000).toFixed(1)} km${late ? ` · ⚠️ ${late}× nicht pünktlich machbar` : ' · alle pünktlich ✓'}`, 4500);
  } catch (e) {
    order = nearestOrder(start, stops); setRoute(null);
    toast('Routendienst nicht erreichbar – grobe Reihenfolge nach Luftlinie');
  }
  db.tour = [...order.map(s => s.o), ...noPoint, ...doneStops()];
  save(); renderTour(); if (map) drawMap();
}
// „Losfahren“: Ankunftszeiten ab jetzt neu rechnen (z. B. wenn du noch auf Pizzen gewartet hast)
function departNow() {
  if (!lastRoute) return;
  lastRoute.departAt = Date.now();
  openStops().forEach(o => { delete o.arrivedAt; delete o.arrivePos; });
  computeEta(lastRoute.departAt); save(); renderTour();
  toast('Gute Fahrt! 🛵 Zeiten ab jetzt gerechnet');
}

// Lieferzeit "20:30" → Zeitpunkt heute; Minuten zu spät (ETA − Lieferzeit), sonst ≤ 0
function dueMs(o) {
  if (!o.time) return null;
  const [h, m] = o.time.split(':').map(Number);
  const d = new Date(o.addedAt || Date.now()); d.setHours(h, m, 0, 0);
  return d.getTime();
}
function timeText(o, eta, late, bold) {
  const parts = [];
  if (o.time) parts.push(`🕗 Lieferzeit ${bold ? `<b>${esc(o.time)}</b>` : esc(o.time)}`);
  if (eta) parts.push(`${o.time ? '' : '🕗 '}Ankunft ca. ${tm(eta)}`);
  let txt = parts.join(' · ');
  if (late > 0) txt += ` · ⚠️ ${late} Min zu spät`; else if (eta && o.time) txt += ' ✓';
  return txt;
}
function lateBy(o) {
  const eta = lastRoute?.eta?.[o.id], due = dueMs(o);
  return eta && due ? Math.round((eta - due) / 60000) : -999;
}

// ---------- GPS während der Tour: Ankunft erkennen, Zeiten & Parkplatz lernen ----------
// Läuft nur, solange die App offen ist (Handys stoppen GPS für Web-Apps im Hintergrund).
let tourWatch = null;
function onFix(p) {
  const pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
  if (map) showMe(pos);
  if (pos.acc > 80) return; // zu ungenau
  let changed = false;
  openStops().forEach(o => {
    if (o.arrivedAt) return;
    const c = db.customers[o.custId]; const door = doorPoint(c) || target(c); if (!door) return;
    if (hav(pos, door) < 0.3) { // innerhalb 300 m = angekommen
      o.arrivedAt = Date.now(); o.arrivePos = { lat: pos.lat, lng: pos.lng }; changed = true;
      // Fahrzeit lernen: Abfahrt = letzte Lieferung oder „Losfahren“
      if (lastRoute?.seq) {
        const k = lastRoute.seq.indexOf(o.id);
        const prev = k > 0 ? db.tour.find(x => x.id === lastRoute.seq[k - 1]) : null;
        const from = prev ? prev.doneAt : (k === 0 ? lastRoute.departAt : null);
        if (from && k >= 0) learnDrive((o.arrivedAt - from) / 1000, lastRoute.legs[k]);
      }
    }
  });
  if (changed) { save(); if (current === 'tour') renderTour(); }
}
function syncWatch() {
  const want = document.visibilityState === 'visible' && openStops().length > 0 && navigator.geolocation;
  if (want && tourWatch == null) tourWatch = navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  if (!want && tourWatch != null) { navigator.geolocation.clearWatch(tourWatch); tourWatch = null; }
}
document.addEventListener('visibilitychange', syncWatch);

// ---------- Ansicht: Tour ----------
function renderTour() {
  const open = openStops(), done = doneStops();
  const sum = open.reduce((a, o) => a + (+o.amount || 0), 0);
  const cash = open.filter(o => o.pay === 'bar').reduce((a, o) => a + (+o.amount || 0), 0);
  const v = $('#view-tour');
  v.innerHTML = `
    <div class="brand"><img src="subito-logo.png" alt="Subito"></div>
    <div class="summary">
      <div class="stat"><b>${open.length}</b><small>offen</small></div>
      <div class="stat"><b>${fr(sum)}</b><small>CHF total</small></div>
      <div class="stat"><b>${fr(cash)}</b><small>CHF bar kassieren</small></div>
    </div>
    ${lastRoute && open.length ? `<p class="hint">Route: ca. ${Math.round(lastRoute.dur * driveFactor() / 60)} Min · ${(lastRoute.dist / 1000).toFixed(1)} km${db.learn?.driveN ? ` · gelernt: du fährst ${Math.round((driveFactor() - 1) * 100) >= 0 ? '+' : ''}${Math.round((driveFactor() - 1) * 100)} % gegenüber Berechnung` : ''}</p>
      <button class="btn block ok" data-act="depart" type="button">🚗 Losfahren (Zeiten ab jetzt)</button>` : ''}
    <div class="row">
      <button class="btn primary" data-act="add" type="button">＋ Bestellung</button>
      <button class="btn" data-act="opt" type="button" ${open.length < 1 ? 'disabled' : ''}>⚡ Beste Reihenfolge</button>
    </div>
    ${open.length > 1 && db.settings.navApp === 'google' ? '<button class="btn block mt" data-act="allnav" type="button">Ganze Tour in Google Maps</button>' : ''}
    ${open.length ? `<ol class="stops">${open.map((o, i) => stopCard(o, i + 1)).join('')}</ol>`
      : '<div class="empty">Keine offenen Bestellungen.<br>Tippe auf „＋ Bestellung“ oder fotografiere den Zettel.</div>'}
    ${done.length ? `<h2>Erledigt (${done.length})</h2><ol class="stops">${done.map(o => stopCard(o, '✓')).join('')}</ol>
      <button class="btn block" data-act="cleardone" type="button">Erledigte aus der Liste entfernen</button>` : ''}`;
  syncWatch();
}
function stopCard(o, n) {
  const c = db.customers[o.custId] || {};
  const st = c.id ? custStats(c) : { n: 0 };
  const min = ORTE[c.ort];
  const tooLow = min && +o.amount && +o.amount < min;
  const t = target(c);
  const eta = !o.done && lastRoute?.eta?.[o.id];
  const late = lateBy(o);
  const timeLine = (o.time || eta) && !o.done
    ? `<div class="time ${late > 0 ? 'late' : ''}">${timeText(o, eta, late, true)}</div>` : '';
  return `<li class="card ${o.done ? 'done' : ''}">
    <div class="num">${n}</div>
    <div>
      ${timeLine}
      <div class="addr">${esc(c.street)}</div>
      ${c.name ? `<div class="sub">👤 ${esc(c.name)}</div>` : ''}
      <div class="sub">${esc(c.plz)} ${esc(c.ort)} · CHF ${fr(o.amount)} · ${payLabel(o.pay)}${o.done ? ` · Trinkgeld ${fr(o.tip)}` : ''}</div>
      ${st.n ? `<div class="sub">Schon ${st.n}× beliefert · Ø Trinkgeld ${fr(st.avgTip)}</div>` : '<div class="sub">Neuer Kunde</div>'}
      ${(c.tags || []).length ? `<div class="chips">${c.tags.map(x => `<span class="chip hot">${esc(x)}</span>`).join('')}</div>` : ''}
      ${c.notes ? `<div class="note">📝 ${esc(c.notes)}</div>` : ''}
      ${o.note ? `<div class="note">🧾 ${esc(o.note)}</div>` : ''}
      <div class="chips">${c.park ? '<span class="chip">🅿️ Parkplatz gemerkt</span>' : ''}${c.bell ? '<span class="chip">🔔 Klingel gemerkt</span>' : ''}</div>
      ${!t ? '<div class="warn">⚠️ Kein Kartenpunkt – im Kunden auf der Karte setzen</div>' : ''}
      ${t && c.approx && !c.park && !c.bell ? '<div class="warn">⚠️ Punkt nur ungefähr (Hausnummer nicht gefunden)</div>' : ''}
      ${tooLow ? `<div class="warn">⚠️ Unter Mindestbestellwert ${min}.– für ${esc(c.ort)}</div>` : ''}
    </div>
    ${o.done ? '' : `<div class="actions">
      <div class="arow">
        ${t ? `<a class="btn" href="${navUrl(t)}" target="_blank" rel="noopener">🧭 Navi</a>` : ''}
        ${c.phone ? `<a class="btn call" href="tel:${esc(c.phone)}">📞 Anrufen</a>` : `<button class="btn" data-act="cust" data-id="${esc(c.id)}" type="button">📞 Nummer fehlt</button>`}
      </div>
      <div class="arow">
        <button class="btn ok" data-act="done" data-id="${o.id}" type="button">✓ Geliefert</button>
        <button class="btn" data-act="cust" data-id="${esc(c.id)}" type="button">Kunde</button>
        <button class="btn danger x" data-act="del" data-id="${o.id}" type="button" aria-label="Entfernen">✕</button>
      </div>
    </div>`}
  </li>`;
}
const payLabel = p => ({ bar: 'Bar', karte: 'Karte', online: 'Online bezahlt' }[p] || p);

$('#view-tour').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  ({
    add: () => orderDialog(),
    opt: () => optimizeTour(),
    depart: () => departNow(),
    allnav: () => {
      const pts = openStops().map(o => target(db.customers[o.custId])).filter(Boolean);
      if (!pts.length) return;
      const last = pts.pop();
      const wp = pts.map(p => `${p.lat},${p.lng}`).join('|');
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${last.lat},${last.lng}${wp ? '&waypoints=' + enc(wp) : ''}&travelmode=driving`, '_blank');
    },
    done: () => deliveredDialog(id),
    cust: () => customerDialog(id),
    del: () => { if (confirm('Bestellung aus der Tour entfernen?')) { db.tour = db.tour.filter(o => o.id !== id); setRoute(null); save(); renderTour(); } },
    cleardone: () => { db.tour = openStops(); save(); renderTour(); }
  })[b.dataset.act]?.();
});

// ---------- Dialoge ----------
function openDialog(html) {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog" class="dlg">${html}</form>`;
  d.showModal();
  return d;
}
const closeDialog = () => $('#dlg').close();

function orderDialog() {
  const ortOptions = Object.keys(ORTE).map(o => `<option value="${esc(o)}">`).join('');
  const streetOptions = Object.values(db.customers).map(c => `<option value="${esc(c.street)}">${esc(c.ort)}</option>`).join('');
  const d = openDialog(`
    <h3>Neue Bestellung</h3>
    <div class="row">
      <label class="btn" style="flex:1">📷 Zettel fotografieren<input id="oFoto" type="file" accept="image/*" capture="environment" hidden></label>
      <button class="btn" id="oPaste" type="button" style="flex:1">📋 Text einfügen</button>
    </div>
    <p class="hint" id="oStatus"></p>
    <div class="grid2">
      <div><label class="f" for="oTime">Lieferzeit</label><input id="oTime" type="time"></div>
      <div><label class="f" for="oName">Name</label><input id="oName" autocomplete="off"></div>
    </div>
    <label class="f" for="oStreet">Strasse und Nr.</label>
    <input id="oStreet" list="dlStreets" autocomplete="off" placeholder="z. B. Bahnhofstrasse 12">
    <datalist id="dlStreets">${streetOptions}</datalist>
    <div class="grid2">
      <div><label class="f" for="oPlz">PLZ</label><input id="oPlz" inputmode="numeric" maxlength="4"></div>
      <div><label class="f" for="oOrt">Ort</label><input id="oOrt" list="dlOrte" value="${esc(db.settings.lastOrt)}"><datalist id="dlOrte">${ortOptions}</datalist></div>
    </div>
    <div id="oKnown"></div>
    <label class="f" for="oPhone">Telefon</label>
    <input id="oPhone" type="tel" inputmode="tel">
    <div class="grid2">
      <div><label class="f" for="oAmount">Betrag CHF</label><input id="oAmount" inputmode="decimal"></div>
      <div><label class="f" for="oPay">Zahlung</label>
        <select id="oPay"><option value="bar">Bar</option><option value="karte">Karte</option><option value="online">Online bezahlt</option></select></div>
    </div>
    <p class="warn" id="oMin"></p>
    <label class="f" for="oNote">Notiz zu dieser Bestellung</label>
    <input id="oNote" placeholder="z. B. 2 Pizzen, 1 Cola">
    <details id="oRawBox" hidden><summary>Erkannter Text</summary><pre class="raw" id="oRaw"></pre></details>
    <div class="foot">
      <button class="btn" value="cancel" type="submit">Abbrechen</button>
      <button class="btn primary" id="oSave" type="button">Hinzufügen</button>
    </div>`);

  const f = id => $('#' + id, d);
  const status = s => { f('oStatus').textContent = s; };
  const fill = p => {
    if (p.street) f('oStreet').value = p.street;
    if (p.plz) f('oPlz').value = p.plz;
    if (p.ort) f('oOrt').value = p.ort;
    if (p.phone) f('oPhone').value = p.phone;
    if (p.amount) f('oAmount').value = p.amount;
    if (p.name) f('oName').value = p.name;
    if (p.time) f('oTime').value = p.time;
    if (p.pay) f('oPay').value = p.pay;
    if (p.etage && p.etage !== '0') f('oNote').value = `Etage ${p.etage}` + (f('oNote').value ? ' · ' + f('oNote').value : '');
    showKnown(); checkMin();
  };
  const showKnown = () => {
    const c = findCustomer(f('oStreet').value, f('oOrt').value);
    if (!c) { f('oKnown').innerHTML = ''; return; }
    if (!f('oPlz').value && c.plz) f('oPlz').value = c.plz;
    if (!f('oPhone').value && c.phone) f('oPhone').value = c.phone;
    if (!f('oName').value && c.name) f('oName').value = c.name;
    if (c.ort && norm(f('oOrt').value) !== norm(c.ort)) f('oOrt').value = c.ort;
    const st = custStats(c);
    f('oKnown').innerHTML = `<div class="known"><b>Bekannter Kunde</b> · ${st.n}× beliefert · Ø Trinkgeld ${fr(st.avgTip)}
      ${(c.tags || []).length ? `<div class="chips">${c.tags.map(x => `<span class="chip hot">${esc(x)}</span>`).join('')}</div>` : ''}
      ${c.notes ? `<div class="note">📝 ${esc(c.notes)}</div>` : ''}
      <div class="chips">${c.park ? '<span class="chip">🅿️ Parkplatz gemerkt</span>' : ''}${c.bell ? '<span class="chip">🔔 Klingel gemerkt</span>' : ''}</div></div>`;
  };
  const checkMin = () => {
    const min = ORTE[f('oOrt').value]; const a = +f('oAmount').value.replace(',', '.');
    f('oMin').textContent = min && a && a < min ? `⚠️ Mindestbestellwert für ${f('oOrt').value}: ${min}.–` : '';
  };
  f('oStreet').addEventListener('input', showKnown);
  f('oOrt').addEventListener('input', () => { showKnown(); checkMin(); });
  f('oAmount').addEventListener('input', checkMin);

  f('oFoto').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const text = await ocr(file, status);
      f('oRaw').textContent = text; f('oRawBox').hidden = false;
      const p = parseOrder(text); fill(p);
      status(p.street ? '✓ Gelesen – bitte kurz kontrollieren' : 'Adresse nicht sicher erkannt – bitte von Hand ergänzen');
    } catch (err) { status('Texterkennung ging nicht (Internet beim ersten Mal nötig). Bitte von Hand eintippen.'); }
  });
  f('oPaste').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* Zugriff verweigert */ }
    if (!text) text = prompt('Bestelltext hier einfügen (z. B. aus WhatsApp):') || '';
    if (!text) return;
    f('oRaw').textContent = text; f('oRawBox').hidden = false;
    fill(parseOrder(text)); status('✓ Text übernommen – bitte kontrollieren');
  });

  f('oSave').addEventListener('click', async () => {
    const street = f('oStreet').value.trim(), ort = f('oOrt').value.trim();
    if (!street || !ort) return status('Bitte Strasse und Ort eingeben');
    const plz = f('oPlz').value.trim(), phone = f('oPhone').value.replace(/\s/g, '');
    const c = upsertCustomer({ street, plz, ort, phone, name: f('oName').value.trim() });
    db.settings.lastOrt = ort;
    db.tour.push({ id: uid(), custId: c.id, amount: f('oAmount').value.replace(',', '.') || '0', pay: f('oPay').value,
      note: f('oNote').value.trim(), time: f('oTime').value, done: false, addedAt: Date.now() });
    setRoute(null);
    save();
    if (c.lat == null) {
      f('oSave').disabled = true; status('Suche Adresse auf der Karte…');
      const p = await geocode(street, plz, ort);
      if (p) { c.lat = p.lat; c.lng = p.lng; c.approx = p.approx; save(); if (p.approx) toast('Hausnummer nicht gefunden – Punkt ist ungefähr', 3500); }
      else toast('⚠️ Adresse nicht gefunden – Punkt im Kunden auf der Karte setzen', 4000);
    }
    closeDialog(); renderTour(); if (map) drawMap();
  });
}

function deliveredDialog(orderId) {
  const o = db.tour.find(x => x.id === orderId); if (!o) return;
  const c = db.customers[o.custId];
  const amt = +o.amount || 0;
  const isCash = o.pay === 'bar' && amt > 0;
  // Vorschläge, was der Kunde gibt: passend, nächste 5/10er, 20/50/100/200
  const gives = isCash ? [...new Set([amt, Math.ceil(amt / 5) * 5, Math.ceil(amt / 10) * 10, 20, 50, 100, 200])]
    .filter(v => v >= amt).sort((a, b) => a - b).slice(0, 5) : [];
  const autoPark = !c.park && o.arrivePos && doorPoint(c) && hav(o.arrivePos, doorPoint(c)) > 0.015;
  const d = openDialog(`
    <h3>Geliefert ✓</h3>
    <p class="sub">${esc(addrLine(c))} · CHF ${fr(amt)} · ${payLabel(o.pay)}</p>
    ${isCash ? `
      <label class="f">💵 Kunde gibt CHF</label>
      <div class="tips">${gives.map(v => `<button type="button" data-give="${v}">${v === amt ? 'Genau' : v}</button>`).join('')}</div>
      <input id="dGive" class="mt" inputmode="decimal" placeholder="anderer Betrag">
      <div class="change" id="dChange">Wähle, was der Kunde gibt</div>
      <div class="row" id="dKeepRow" hidden>
        <button class="btn sm" id="dKeep" type="button">„Stimmt so“ – Rest ist Trinkgeld</button>
        <button class="btn sm" id="dRound" type="button"></button>
      </div>` : ''}
    <label class="f">Trinkgeld CHF</label>
    <div class="tips">${[0, 1, 2, 3, 5].map(v => `<button type="button" data-tip="${v}">${v}</button>`).join('')}</div>
    <input id="dTip" class="mt" inputmode="decimal" placeholder="anderer Betrag" value="0">
    <label class="toggle"><input type="checkbox" id="dBell" ${c.bell ? '' : 'checked'}> Meine Position jetzt als Klingel/Eingang merken</label>
    ${autoPark ? '<p class="hint">🅿️ Parkplatz wird automatisch gelernt (dort, wo du angekommen bist).</p>'
      : `<label class="toggle"><input type="checkbox" id="dPark"> Hier habe ich gut parkiert (Parkplatz merken)</label>`}
    <div class="foot">
      <button class="btn" value="cancel" type="submit">Zurück</button>
      <button class="btn ok" id="dOk" type="button">Speichern</button>
    </div>`);
  const tipIn = $('#dTip', d);
  const setTip = v => { tipIn.value = fr(v); $$('[data-tip]', d).forEach(x => x.classList.toggle('on', +x.dataset.tip === +v)); };
  $$('[data-tip]', d).forEach(b => b.addEventListener('click', () => setTip(b.dataset.tip)));
  if (isCash) {
    const giveIn = $('#dGive', d), out = $('#dChange', d), keepRow = $('#dKeepRow', d);
    const update = () => {
      const g = +giveIn.value.replace(',', '.') || 0;
      $$('[data-give]', d).forEach(x => x.classList.toggle('on', +x.dataset.give === g));
      if (!g) { out.textContent = 'Wähle, was der Kunde gibt'; keepRow.hidden = true; return; }
      if (g < amt) { out.innerHTML = `⚠️ Es fehlen noch <b>CHF ${fr(amt - g)}</b>`; keepRow.hidden = true; return; }
      const tip = +tipIn.value.replace(',', '.') || 0;
      const back = Math.round((g - amt - tip) * 100) / 100;
      out.innerHTML = back >= 0 ? `Zurückgeben: <b>CHF ${fr(back)}</b>${tip ? ` <small>(${fr(tip)} Trinkgeld behalten)</small>` : ''}` : '⚠️ Trinkgeld grösser als Rest';
      keepRow.hidden = g === amt;
      const r5 = Math.ceil((amt + 0.01) / 5) * 5;
      const rb = $('#dRound', d);
      rb.hidden = !(r5 < g && r5 > amt);
      rb.textContent = `Auf ${r5}.– aufrunden`; rb.dataset.r = r5;
    };
    $$('[data-give]', d).forEach(b => b.addEventListener('click', () => { giveIn.value = fr(b.dataset.give); setTip(0); update(); }));
    giveIn.addEventListener('input', update);
    tipIn.addEventListener('input', update);
    $$('[data-tip]', d).forEach(b => b.addEventListener('click', update));
    $('#dKeep', d).addEventListener('click', () => { setTip((+giveIn.value.replace(',', '.') || 0) - amt); update(); });
    $('#dRound', d).addEventListener('click', e => { setTip(+e.target.dataset.r - amt); update(); });
  }
  $('#dOk', d).addEventListener('click', async () => {
    const tip = Math.max(0, +tipIn.value.replace(',', '.') || 0);
    const wantBell = $('#dBell', d).checked, wantPark = $('#dPark', d)?.checked;
    $('#dOk', d).disabled = true;
    if (wantBell || wantPark) {
      try {
        const p = await gps();
        if (p.acc > 60) toast(`GPS ungenau (±${Math.round(p.acc)} m) – Punkt später prüfen`, 3500);
        const pt = { lat: p.lat, lng: p.lng };
        if (wantBell) c.bell = pt;
        if (wantPark) c.park = pt;
      } catch (e) { toast('GPS nicht verfügbar – Punkt nicht gespeichert'); }
    }
    o.done = true; o.tip = tip; o.doneAt = Date.now();
    // Lernen: Übergabezeit (Ankunft → Geliefert) und Parkplatz
    let learned = '';
    if (o.arrivedAt) {
      const min = (o.doneAt - o.arrivedAt) / 60000;
      if (min >= 0.5 && min <= 20) c.svc = [...(c.svc || []), Math.round(min * 10) / 10].slice(-10);
    }
    if (autoPark) { c.park = o.arrivePos; learned = ' · 🅿️ Parkplatz gelernt'; }
    c.visits.push({ t: o.doneAt, tip, amount: amt });
    const sh = ensureShift();
    sh.deliveries.push({ t: o.doneAt, custId: c.id, addr: addrLine(c), amount: amt, tip, pay: o.pay });
    computeEta(Date.now());
    save(); closeDialog(); renderTour(); if (map) drawMap();
    toast((tip ? `Merci! +${fr(tip)} Trinkgeld 💰` : 'Gespeichert ✓') + learned, 3000);
    if (db.settings.autoNext !== false) setTimeout(nextStopDialog, 350);
  });
}

// Nach „Geliefert“: nächster Kunde mit grossem Navi- und Anrufen-Knopf
function nextStopDialog() {
  const o = openStops()[0];
  if (!o) {
    const b = db.settings.base;
    openDialog(`<h3>Tour fertig! 🎉</h3><p class="sub">Alle Bestellungen geliefert.</p>
      <div class="foot">${b ? `<a class="btn primary" href="${navUrl(b)}" target="_blank" rel="noopener">🍕 Zurück zu Subito</a>` : ''}
      <button class="btn" value="cancel" type="submit">OK</button></div>`);
    return;
  }
  const c = db.customers[o.custId], t = target(c), eta = lastRoute?.eta?.[o.id], late = lateBy(o);
  openDialog(`
    <h3>Weiter: ${esc(c.street)}</h3>
    <p class="sub">${c.name ? esc(c.name) + ' · ' : ''}${esc(c.plz)} ${esc(c.ort)} · CHF ${fr(o.amount)} · ${payLabel(o.pay)}</p>
    ${o.time || eta ? `<p class="time ${late > 0 ? 'late' : ''}">${timeText(o, eta, late, false)}</p>` : ''}
    ${(c.tags || []).length ? `<div class="chips">${c.tags.map(x => `<span class="chip hot">${esc(x)}</span>`).join('')}</div>` : ''}
    ${c.notes ? `<div class="note">📝 ${esc(c.notes)}</div>` : ''}
    ${o.note ? `<div class="note">🧾 ${esc(o.note)}</div>` : ''}
    ${c.park ? '<p class="hint">🅿️ Navi führt dich direkt zum gemerkten Parkplatz.</p>' : ''}
    <div class="bigbtns">
      ${t ? `<a class="btn primary" href="${navUrl(t)}" target="_blank" rel="noopener">🧭 Navi starten</a>` : ''}
      ${c.phone ? `<a class="btn call" href="tel:${esc(c.phone)}">📞 Anrufen</a>` : ''}
      <button class="btn" value="cancel" type="submit">Später</button>
    </div>`);
}

function customerDialog(id) {
  const c = db.customers[id]; if (!c) return;
  const st = custStats(c);
  const pt = (p, name) => p ? `✓ gemerkt <a href="${navUrl(p)}" target="_blank" rel="noopener">(öffnen)</a>` : `<span class="sub">noch nicht gesetzt</span>`;
  const d = openDialog(`
    <h3>${esc(c.street)}</h3>
    <p class="sub">${esc(c.plz)} ${esc(c.ort)} · ${st.n}× beliefert · Ø Trinkgeld ${fr(st.avgTip)}${st.last ? ' · zuletzt ' + dt(st.last) : ''}</p>
    <label class="f">Merkmale</label>
    <div class="tagpick">${TAGS.map(t => `<button type="button" class="${c.tags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <label class="f" for="cNotes">Notiz</label>
    <textarea id="cNotes" placeholder="z. B. 2. Stock links, Name steht „Muster“, beim Eingang Code 1234">${esc(c.notes)}</textarea>
    <label class="f" for="cPhone">Telefon</label>
    <div class="row"><input id="cPhone" type="tel" value="${esc(c.phone)}" style="flex:1">${c.phone ? `<a class="btn call" href="tel:${esc(c.phone)}">📞 Anrufen</a>` : ''}</div>
    <label class="f">🅿️ Parkplatz: ${pt(c.park)}</label>
    <div class="row"><button class="btn sm" data-pick="park" type="button">Auf Karte setzen</button><button class="btn sm" data-gps="park" type="button">Hier (GPS)</button>${c.park ? '<button class="btn sm danger" data-clear="park" type="button">Löschen</button>' : ''}</div>
    <label class="f">🔔 Klingel / Eingang: ${pt(c.bell)}</label>
    <div class="row"><button class="btn sm" data-pick="bell" type="button">Auf Karte setzen</button><button class="btn sm" data-gps="bell" type="button">Hier (GPS)</button>${c.bell ? '<button class="btn sm danger" data-clear="bell" type="button">Löschen</button>' : ''}</div>
    <label class="f">🏠 Hauspunkt: ${c.lat != null ? '✓' : '<span class="warn">fehlt</span>'}</label>
    <div class="row"><button class="btn sm" data-pick="house" type="button">Auf Karte korrigieren</button></div>
    ${st.n ? `<label class="f">Verlauf</label><table class="t">${c.visits.slice(-8).reverse().map(v => `<tr><td>${dt(v.t)}</td><td class="r">CHF ${fr(v.amount)}</td><td class="r">+${fr(v.tip)}</td></tr>`).join('')}</table>` : ''}
    <div class="foot">
      <button class="btn danger" id="cDel" type="button">Löschen</button>
      <button class="btn primary" id="cSave" type="button">Speichern</button>
    </div>`);
  const keep = () => { c.notes = $('#cNotes', d).value.trim(); c.phone = $('#cPhone', d).value.replace(/\s/g, ''); };
  $$('[data-tag]', d).forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tag; c.tags = c.tags.includes(t) ? c.tags.filter(x => x !== t) : [...c.tags, t]; b.classList.toggle('on');
  }));
  $$('[data-pick]', d).forEach(b => b.addEventListener('click', () => { keep(); save(); closeDialog(); startPick(b.dataset.pick, c.id); }));
  $$('[data-gps]', d).forEach(b => b.addEventListener('click', async () => {
    try { const p = await gps(); c[b.dataset.gps] = { lat: p.lat, lng: p.lng }; keep(); save(); toast(`Gespeichert (±${Math.round(p.acc)} m)`); customerDialog(c.id); }
    catch (e) { toast('GPS nicht verfügbar'); }
  }));
  $$('[data-clear]', d).forEach(b => b.addEventListener('click', () => { c[b.dataset.clear] = null; keep(); save(); customerDialog(c.id); }));
  $('#cSave', d).addEventListener('click', () => { keep(); save(); closeDialog(); refreshAll(); toast('Kunde gespeichert ✓'); });
  $('#cDel', d).addEventListener('click', () => {
    if (!confirm('Kunde mit allen Notizen löschen?')) return;
    delete db.customers[c.id]; db.tour = db.tour.filter(o => o.custId !== c.id); save(); closeDialog(); refreshAll();
  });
}

// ---------- Karte ----------
let map, layer, routeLayer, meMarker, pick = null, watchId = null;
const icon = (cls, txt, size) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${txt}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
function initMap() {
  const b = db.settings.base;
  map = L.map('map', { zoomControl: false, maxZoom: 20 }).setView(b ? [b.lat, b.lng] : [46.96, 9.56], 13);
  // Echte Luftbilder der Schweiz (swisstopo, gratis, ohne Schlüssel) + Strassennamen darüber
  const swiss = 'https://wmts.geo.admin.ch/1.0.0/{layer}/default/current/3857/{z}/{x}/{y}.{ext}';
  const sat = L.layerGroup([
    L.tileLayer(swiss, { layer: 'ch.swisstopo.swissimage', ext: 'jpeg', maxZoom: 20, maxNativeZoom: 20, attribution: '© swisstopo' }),
    L.tileLayer(swiss, { layer: 'ch.swisstopo.swissnames3d', ext: 'png', maxZoom: 20, maxNativeZoom: 18, opacity: 0.9 })
  ]);
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  const lk = L.tileLayer(swiss, { layer: 'ch.swisstopo.pixelkarte-farbe', ext: 'jpeg', maxZoom: 20, maxNativeZoom: 18, attribution: '© swisstopo' });
  const bases = { 'Satellit': sat, 'Strassenkarte': street, 'Landeskarte': lk };
  (bases[db.settings.mapStyle] || sat).addTo(map);
  L.control.layers(bases, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', e => { db.settings.mapStyle = e.name; save(); });
  routeLayer = L.layerGroup().addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', e => {
    if (!pick) return;
    const c = db.customers[pick.custId]; if (!c) return endPick();
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (pick.kind === 'house') { c.lat = p.lat; c.lng = p.lng; c.approx = false; } else c[pick.kind] = p;
    save(); const id = c.id; endPick(); drawMap(); renderTour(); toast('Punkt gespeichert ✓');
    setTimeout(() => customerDialog(id), 400);
  });
  $('#btnMe').addEventListener('click', async () => {
    try { const p = await gps(); showMe(p); map.setView([p.lat, p.lng], 17); } catch (e) { toast('GPS nicht verfügbar'); }
  });
  $('#btnFit').addEventListener('click', fitTour);
  drawMap();
}
function showMe(p) {
  if (!meMarker) meMarker = L.marker([p.lat, p.lng], { icon: icon('me', '', 18), zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng([p.lat, p.lng]);
}
function drawMap() {
  if (!map) return;
  layer.clearLayers(); routeLayer.clearLayers();
  const b = db.settings.base;
  if (b) L.marker([b.lat, b.lng], { icon: icon('base', '🍕', 32) }).bindPopup(`<b>${SUBITO.name}</b><br>${SUBITO.street}, ${SUBITO.plz} ${SUBITO.ort}`).addTo(layer);
  const tourIds = new Set();
  openStops().forEach((o, i) => {
    const c = db.customers[o.custId]; if (!c) return; tourIds.add(c.id);
    if (c.lat != null) {
      L.marker([c.lat, c.lng], { icon: icon('stop', i + 1, 30), zIndexOffset: 500 }).bindPopup(popup(c, o)).addTo(layer);
    }
    addExtras(c);
  });
  // Alle anderen bekannten Kunden klein anzeigen
  Object.values(db.customers).forEach(c => {
    if (tourIds.has(c.id) || c.lat == null) return;
    L.marker([c.lat, c.lng], { icon: icon('cust', '', 14) }).bindPopup(popup(c)).addTo(layer);
  });
  if (lastRoute && openStops().length) L.geoJSON(lastRoute.geo, { style: { color: '#d71920', weight: 5, opacity: .75 } }).addTo(routeLayer);
}
function addExtras(c) {
  if (c.park) L.marker([c.park.lat, c.park.lng], { icon: icon('park', 'P', 26) }).bindPopup(`🅿️ Parkplatz für ${esc(c.street)}<br><a href="${navUrl(c.park)}" target="_blank" rel="noopener">Hierhin navigieren</a>`).addTo(layer);
  if (c.bell) L.marker([c.bell.lat, c.bell.lng], { icon: icon('bell', '🔔', 26) }).bindPopup(`🔔 Klingel/Eingang ${esc(c.street)}`).addTo(layer);
}
function popup(c, o) {
  const t = target(c);
  return `<b>${esc(c.street)}</b><br>${esc(c.plz)} ${esc(c.ort)}
    ${o ? `<br>CHF ${fr(o.amount)} · ${payLabel(o.pay)}` : ''}
    ${(c.tags || []).length ? `<br>⚠️ ${c.tags.map(esc).join(', ')}` : ''}
    ${c.notes ? `<br>📝 ${esc(c.notes)}` : ''}
    <br>${t ? `<a href="${navUrl(t)}" target="_blank" rel="noopener">🧭 Navi</a> · ` : ''}${c.phone ? `<a href="tel:${esc(c.phone)}">📞 Anrufen</a> · ` : ''}<a href="#" data-cust="${esc(c.id)}">Kunde öffnen</a>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-cust]'); if (!a) return;
  e.preventDefault(); customerDialog(a.dataset.cust);
});
function fitTour() {
  const pts = [];
  if (db.settings.base) pts.push([db.settings.base.lat, db.settings.base.lng]);
  openStops().forEach(o => { const c = db.customers[o.custId]; if (c && c.lat != null) pts.push([c.lat, c.lng]); });
  if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40] });
  else if (pts.length) map.setView(pts[0], 15);
}
function startPick(kind, custId) {
  pick = { kind, custId };
  showView('karte');
  const c = db.customers[custId];
  const label = { park: '🅿️ Tippe, wo du parkierst', bell: '🔔 Tippe auf die Klingel/den Eingang', house: '🏠 Tippe auf das Haus' }[kind];
  const bar = $('#pickbar'); bar.hidden = false;
  bar.innerHTML = `<span>${label}</span><button type="button" id="pickX">Abbrechen</button>`;
  $('#pickX').onclick = endPick;
  const p = doorPoint(c) || db.settings.base;
  if (p) map.setView([p.lat, p.lng], 18);
}
function endPick() { pick = null; $('#pickbar').hidden = true; }

// ---------- Ansicht: Kunden ----------
function renderKunden(q = '') {
  const v = $('#view-kunden');
  const list = Object.values(db.customers)
    .filter(c => !q || norm(addrLine(c) + ' ' + c.notes + ' ' + c.phone).includes(norm(q)))
    .sort((a, b) => (custStats(b).last || b.created) - (custStats(a).last || a.created));
  const inp = $('#kq', v);
  if (!inp) {
    v.innerHTML = `<input id="kq" type="search" placeholder="Suchen: Strasse, Ort, Notiz, Telefon"><div id="klist" class="list mt"></div>`;
    $('#kq', v).addEventListener('input', e => renderKunden(e.target.value));
  }
  $('#klist', v).innerHTML = list.length ? list.map(c => {
    const st = custStats(c);
    return `<button class="item" data-cust-open="${esc(c.id)}" type="button">
      <div class="addr">${esc(c.street)}</div>
      <div class="sub">${esc(c.plz)} ${esc(c.ort)} · ${st.n}× · Ø Trinkgeld ${fr(st.avgTip)} ${c.park ? '· 🅿️' : ''}${c.bell ? ' 🔔' : ''}${c.lat == null ? ' · ⚠️ kein Punkt' : ''}</div>
      ${(c.tags || []).length ? `<div class="chips">${c.tags.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
    </button>`;
  }).join('') : '<div class="empty">Noch keine Kunden. Sie entstehen automatisch, wenn du Bestellungen erfasst.</div>';
}
$('#view-kunden').addEventListener('click', e => { const b = e.target.closest('[data-cust-open]'); if (b) customerDialog(b.dataset.custOpen); });

// ---------- Schicht & Abrechnung ----------
function ensureShift() {
  let s = db.shifts.find(x => x.id === db.activeShift);
  if (!s) { s = { id: uid(), start: Date.now(), end: null, deliveries: [] }; db.shifts.push(s); db.activeShift = s.id; }
  return s;
}
function totals(dels) {
  return dels.reduce((a, d) => ({ n: a.n + 1, amount: a.amount + d.amount, tip: a.tip + d.tip, cash: a.cash + (d.pay === 'bar' ? d.amount : 0) }), { n: 0, amount: 0, tip: 0, cash: 0 });
}
function renderSchicht() {
  const v = $('#view-schicht');
  const act = db.shifts.find(x => x.id === db.activeShift);
  const now = new Date();
  const monthDels = db.shifts.flatMap(s => s.deliveries).filter(d => { const x = new Date(d.t); return x.getMonth() === now.getMonth() && x.getFullYear() === now.getFullYear(); });
  const m = totals(monthDels);
  const monthHours = db.shifts.filter(s => new Date(s.start).getMonth() === now.getMonth() && new Date(s.start).getFullYear() === now.getFullYear())
    .reduce((a, s) => a + ((s.end || Date.now()) - s.start) / 3.6e6, 0);
  let html = '';
  if (act) {
    const t = totals(act.deliveries); const h = (Date.now() - act.start) / 3.6e6;
    html += `<h2>Laufende Schicht seit ${tm(act.start)}</h2>
      <div class="summary">
        <div class="stat"><b>${t.n}</b><small>Lieferungen</small></div>
        <div class="stat"><b>${fr(t.amount)}</b><small>CHF Umsatz</small></div>
        <div class="stat"><b>${fr(t.tip)}</b><small>CHF Trinkgeld</small></div>
      </div>
      <div class="summary">
        <div class="stat"><b>${fr(t.cash)}</b><small>CHF bar kassiert</small></div>
        <div class="stat"><b>${h.toFixed(1)}</b><small>Stunden</small></div>
        <div class="stat"><b>${h > 0.1 ? fr(t.tip / h) : '–'}</b><small>Trinkgeld / Std.</small></div>
      </div>
      <h2>💵 Kassensturz</h2>
      <label class="f" for="shFloat">Wechselgeld am Anfang (CHF)</label>
      <input id="shFloat" inputmode="decimal" value="${act.float ? fr(act.float) : ''}" placeholder="z. B. 100">
      <table class="t mt">
        <tr><td>Wechselgeld am Anfang</td><td class="r">${fr(act.float)}</td></tr>
        <tr><td>+ Bar kassiert (an Subito abgeben)</td><td class="r">${fr(t.cash)}</td></tr>
        <tr><td>+ Trinkgeld (gehört dir)</td><td class="r">${fr(t.tip)}</td></tr>
        <tr><th>= Sollte in der Tasche sein</th><th class="r">${fr((+act.float || 0) + t.cash + t.tip)}</th></tr>
      </table>
      <p class="hint">Annahme: Trinkgeld bekommst du bar. Weicht deine Tasche ab, stimmt irgendwo ein Rückgeld nicht.</p>
      <button class="btn block" data-act="end" type="button">Schicht beenden</button>`;
  } else {
    html += `<h2>Keine Schicht aktiv</h2><p class="hint">Startet automatisch bei der ersten Lieferung.</p>
      <button class="btn primary block" data-act="start" type="button">Schicht starten</button>`;
  }
  html += `<h2>Diesen Monat</h2>
    <div class="summary">
      <div class="stat"><b>${m.n}</b><small>Lieferungen</small></div>
      <div class="stat"><b>${fr(m.amount)}</b><small>CHF Umsatz</small></div>
      <div class="stat"><b>${fr(m.tip)}</b><small>CHF Trinkgeld</small></div>
    </div>
    <p class="hint">${monthHours.toFixed(1)} Stunden erfasst${monthHours > 0.1 ? ` · ${fr(m.tip / monthHours)} Trinkgeld pro Stunde` : ''}</p>
    <h2>Letzte Schichten</h2>
    ${db.shifts.length ? `<table class="t"><tr><th>Datum</th><th class="r">Lief.</th><th class="r">Umsatz</th><th class="r">Trinkg.</th></tr>
      ${db.shifts.slice(-15).reverse().map(s => { const t = totals(s.deliveries); return `<tr><td>${dt(s.start)} ${tm(s.start)}</td><td class="r">${t.n}</td><td class="r">${fr(t.amount)}</td><td class="r">${fr(t.tip)}</td></tr>`; }).join('')}</table>` : '<div class="empty">Noch keine Schichten.</div>'}
    <button class="btn block mt" data-act="csv" type="button">Als Tabelle (CSV) exportieren</button>`;
  v.innerHTML = html;
}
$('#view-schicht').addEventListener('change', e => {
  if (e.target.id !== 'shFloat') return;
  const s = db.shifts.find(x => x.id === db.activeShift); if (!s) return;
  s.float = +e.target.value.replace(',', '.') || 0; save(); renderSchicht();
});
$('#view-schicht').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'start') { ensureShift(); save(); renderSchicht(); toast('Schicht gestartet – gute Fahrt! 🛵'); }
  if (b.dataset.act === 'end') {
    const s = db.shifts.find(x => x.id === db.activeShift); if (!s) return;
    const t = totals(s.deliveries);
    if (!confirm(`Schicht beenden?\n${t.n} Lieferungen · CHF ${fr(t.amount)} Umsatz · CHF ${fr(t.tip)} Trinkgeld\nBar an Subito abgeben: CHF ${fr(t.cash)}\nIn der Tasche sollten sein: CHF ${fr((+s.float || 0) + t.cash + t.tip)}`)) return;
    s.end = Date.now(); db.activeShift = null; db.tour = openStops(); save(); renderSchicht(); renderTour();
  }
  if (b.dataset.act === 'csv') {
    const rows = [['Datum', 'Zeit', 'Adresse', 'Betrag', 'Zahlung', 'Trinkgeld']];
    db.shifts.forEach(s => s.deliveries.forEach(d => rows.push([dt(d.t), tm(d.t), d.addr, fr(d.amount), payLabel(d.pay), fr(d.tip)])));
    download('kurier-lieferungen.csv', rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
  }
});
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Ansicht: Mehr / Einstellungen ----------
function renderEinst() {
  const s = db.settings;
  const v = $('#view-einst');
  v.innerHTML = `
    <div class="brand"><img src="subito-logo.png" alt="Subito"></div>
    <h2>Restaurant (Startpunkt)</h2>
    <p class="hint">${SUBITO.name}, ${SUBITO.street}, ${SUBITO.plz} ${SUBITO.ort} · <a href="tel:${SUBITO.phone}">081 322 20 20</a></p>
    <p class="hint">${s.base ? '✓ Standort gesetzt' : '⚠️ Standort noch nicht gesetzt'}</p>
    <div class="row">
      <button class="btn sm" data-act="basegeo" type="button">Adresse suchen</button>
      <button class="btn sm" data-act="basegps" type="button">Ich bin bei Subito (GPS)</button>
    </div>
    <h2>Route</h2>
    <label class="toggle"><input type="checkbox" id="sRound" ${s.roundtrip ? 'checked' : ''}> Am Schluss zurück zu Subito</label>
    <label class="toggle"><input type="checkbox" id="sGps" ${s.startFromGps ? 'checked' : ''}> Route ab meinem Standort (statt ab Subito)</label>
    <label class="toggle"><input type="checkbox" id="sNext" ${s.autoNext !== false ? 'checked' : ''}> Nach „Geliefert“ gleich den nächsten Stopp zeigen</label>
    <h2>Gelernt</h2>
    <p class="hint">Fahrtempo: ${db.learn?.driveN ? `${Math.round((driveFactor() - 1) * 100)} % gegenüber Berechnung (aus ${db.learn.driveN} Fahrten)` : 'noch keine Fahrten gemessen'}<br>
      Übergabezeit im Schnitt: ${fr(svcMin(null)).replace('.00', '')} Min</p>
    <label class="f" for="sNav">Navi-App</label>
    <select id="sNav">
      <option value="google" ${s.navApp === 'google' ? 'selected' : ''}>Google Maps</option>
      <option value="apple" ${s.navApp === 'apple' ? 'selected' : ''}>Apple Karten</option>
      <option value="waze" ${s.navApp === 'waze' ? 'selected' : ''}>Waze</option>
    </select>
    <h2>Liefergebiet & Mindestbestellwert</h2>
    <table class="t">${Object.entries(ORTE).map(([o, m]) => `<tr><td>${esc(o)}</td><td class="r">${m}.–</td></tr>`).join('')}</table>
    <h2>Daten sichern</h2>
    <p class="hint">Alles ist nur auf diesem Handy gespeichert. Mach ab und zu ein Backup.</p>
    <div class="row">
      <button class="btn sm" data-act="backup" type="button">Backup speichern</button>
      <label class="btn sm">Backup laden<input type="file" id="sImport" accept="application/json" hidden></label>
    </div>
    <button class="btn sm danger block mt" data-act="wipe" type="button">Alle Daten löschen</button>
    <p class="hint mt">Karten © OpenStreetMap-Mitwirkende · Routen: OSRM · Adresssuche: Nominatim</p>`;
  $('#sRound', v).onchange = e => { s.roundtrip = e.target.checked; save(); };
  $('#sGps', v).onchange = e => { s.startFromGps = e.target.checked; save(); };
  $('#sNext', v).onchange = e => { s.autoNext = e.target.checked; save(); };
  $('#sNav', v).onchange = e => { s.navApp = e.target.value; save(); renderTour(); };
  $('#sImport', v).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.customers || !d.shifts) throw new Error();
      if (!confirm('Backup laden? Die aktuellen Daten werden ersetzt.')) return;
      db = { ...structuredClone(EMPTY), ...d, settings: { ...EMPTY.settings, ...(d.settings || {}) } }; save(); refreshAll(); toast('Backup geladen ✓');
    } catch (err) { toast('Das ist keine gültige Backup-Datei'); }
  };
}
$('#view-einst').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'basegeo') {
    toast('Suche Subito…');
    const p = await geocode(SUBITO.street, SUBITO.plz, SUBITO.ort);
    if (p) { db.settings.base = p; save(); renderEinst(); drawMap(); toast('Standort gesetzt ✓ – auf der Karte prüfen'); }
    else toast('Nicht gefunden – nimm „Ich bin bei Subito (GPS)“');
  }
  if (a === 'basegps') {
    try { const p = await gps(); db.settings.base = { lat: p.lat, lng: p.lng }; save(); renderEinst(); drawMap(); toast('Standort gesetzt ✓'); }
    catch (err) { toast('GPS nicht verfügbar'); }
  }
  if (a === 'backup') download(`kurier-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db), 'application/json');
  if (a === 'wipe' && confirm('Wirklich ALLE Kunden, Notizen und Schichten löschen? Das kann man nicht rückgängig machen.')) {
    localStorage.removeItem(KEY); db = structuredClone(EMPTY); refreshAll(); toast('Alles gelöscht');
  }
});

// ---------- Navigation zwischen Ansichten ----------
const TITLES = { tour: 'Tour', karte: 'Karte', kunden: 'Kunden', schicht: 'Schicht', einst: 'Mehr' };
let current = 'tour';
function showView(name) {
  current = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  $('#title').textContent = TITLES[name];
  if (name !== 'karte' && pick) endPick();
  if (name === 'tour') renderTour();
  if (name === 'kunden') renderKunden($('#kq')?.value || '');
  if (name === 'schicht') renderSchicht();
  if (name === 'einst') renderEinst();
  if (name === 'karte') {
    if (!map) initMap(); else { map.invalidateSize(); drawMap(); }
    if (!pick && openStops().length) setTimeout(fitTour, 50);
    if (watchId == null && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(p => showMe({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { enableHighAccuracy: true });
    }
  } else if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}
function refreshAll() { showView(current); if (map) drawMap(); }
$('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); });

function updateNet() { const n = $('#net'); n.textContent = navigator.onLine ? '' : 'Offline'; n.classList.toggle('off', !navigator.onLine); }
addEventListener('online', updateNet); addEventListener('offline', updateNet);

// ---------- Start ----------
updateNet();
renderTour();
if (!db.settings.base) {
  // Beim ersten Start Subito automatisch auf der Karte suchen
  geocode(SUBITO.street, SUBITO.plz, SUBITO.ort).then(p => { if (p && !db.settings.base) { db.settings.base = p; save(); if (map) drawMap(); } });
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
