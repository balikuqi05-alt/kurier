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
  if (!ocrWorker) { onStatus('Starte Texterkennung…'); ocrWorker = Tesseract.createWorker('deu'); }
  const worker = await ocrWorker;
  onStatus('Lese Zettel…');
  const { data } = await worker.recognize(img);
  return data.text || '';
}
let ocrWorker = null; // wird einmal gestartet und für alle Zettel benutzt
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
// Subito-Zettel: Kopf oben rechts = Subito selbst → wird ignoriert.
// Gelesen wird nur der Block unter „Kunden-Adresse“: Name, Strasse, PLZ Ort, Telefon, Etage.
const SUBITO_LINE = /subito|pizza\s*k|center\s*au|kantons?.?strasse\s*24|322\s?20\s?20|www\.|mwst|che[-\s]?\d{3}/i;
// PLZ → Ort im Liefergebiet (zum Korrigieren, wenn die Texterkennung den Ort verunstaltet)
const PLZ_ORT = {
  '7302': 'Landquart', '7206': 'Igis', '7205': 'Zizers', '7208': 'Malans', '7203': 'Trimmis', '7204': 'Untervaz',
  '7304': 'Maienfeld', '7307': 'Jenins', '7306': 'Fläsch', '7310': 'Bad Ragaz', '7303': 'Mastrils', '7214': 'Grüsch',
  '7212': 'Seewis Dorf', '7220': 'Schiers', '7215': 'Fanas', '7213': 'Valzeina', '7233': 'Jenaz', '7235': 'Fideris',
  '7240': 'Küblis', '7000': 'Chur', '7320': 'Sargans', '7312': 'Pfäfers', '7317': 'Valens'
};
function lev(a, b) {
  a = norm(a); b = norm(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function matchOrt(ort, plz) {
  if (ort) {
    let best = null, bd = 99;
    for (const o of Object.keys(ORTE)) {
      const dd = norm(ort).startsWith(norm(o)) ? 0 : lev(ort, o);
      if (dd < bd) { bd = dd; best = o; }
    }
    if (best && bd <= Math.max(1, Math.floor(best.length / 4))) return best;
  }
  return PLZ_ORT[plz] || ort;
}
function parseOrder(text) {
  const all = text.split(/\r?\n|[,;|]/).map(l => l.trim()).filter(Boolean);
  const out = { name: '', street: '', plz: '', ort: '', phone: '', amount: '', pay: '', time: '', etage: '', ref: '' };
  const phoneRe = /(?:\+41|0041|0)\s?\(?0?\)?\s?([1-9]\d)[\s./-]?(\d{3})[\s./-]?(\d{2})[\s./-]?(\d{2})\b/;
  const plzRe = /\b(\d{4})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüéèàç .\-]{1,30})/;
  const streetRe = /([A-Za-zÄÖÜäöüéèàç.\-' ]{3,40}?)\s+(\d{1,4}\s?[a-zA-Z]?)\b/;
  const streetWord = /(str|weg|gasse|platz|rain|halde|quai|allee|ring|hof|matt|acker|bühl|buehl|feld|via|park|berg|dorf|boden|wiese|egg|rank|zelg|gut|au)\b|strasse/i;
  const isDate = l => /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(l);

  // 1) Kundenblock finden: alles nach „Kunden-Adresse“ (OCR-tolerant), ohne Subito-Zeilen
  const anchor = all.findIndex(l => /kunden|k.nden.?adr|adress?e/i.test(l));
  const lines = (anchor >= 0 ? all.slice(anchor + 1) : all).filter(l => !SUBITO_LINE.test(l));

  // 2) Strasse = erste Zeile mit Strassenwort + Hausnummer (keine Telefonnummer, kein Datum)
  let si = lines.findIndex(l => { const m = l.match(streetRe); return m && streetWord.test(m[1]) && !phoneRe.test(l) && !isDate(l); });
  // 3) PLZ/Ort = direkt unter der Strasse (max. 2 Zeilen tiefer); sonst erste PLZ-Zeile
  let pi = -1;
  if (si >= 0) {
    for (let k = si + 1; k <= si + 2 && k < lines.length; k++) { const m = lines[k].match(plzRe); if (m && !isDate(lines[k])) { pi = k; break; } }
  }
  if (pi < 0) pi = lines.findIndex(l => { const m = l.match(plzRe); return m && +m[1] >= 1000 && !isDate(l) && !phoneRe.test(l); });
  if (si < 0 && pi > 0) { const m = lines[pi - 1].match(streetRe); if (m && !phoneRe.test(lines[pi - 1])) si = pi - 1; }
  if (si >= 0) { const m = lines[si].match(streetRe); out.street = `${m[1].trim()} ${m[2]}`.replace(/\s+/g, ' '); }
  if (pi >= 0) { const m = lines[pi].match(plzRe); out.plz = m[1]; out.ort = m[2].trim().replace(/\s+(\d|lieferzeit).*$/i, ''); }

  // 4) Telefon und Etage: erst im Kundenblock, nach der Strasse
  const from = Math.max(0, si);
  for (const l of lines.slice(from)) {
    if (!out.phone) { const m = l.match(phoneRe); if (m) out.phone = '0' + m[1] + m[2] + m[3] + m[4]; }
    if (!out.etage) { const m = l.match(/etage\s*:?\s*(-?\d+|eg|ug|og)/i); if (m) out.etage = m[1]; }
  }

  // 5) Name = Zeile vor der Strasse, ohne Uhrzeit und OCR-Krümel
  if (si > 0) {
    let nm = lines[si - 1].replace(/kunden.?adresse|lieferzeit:?|kopie/ig, '').replace(/\d{1,2}[:.]\d{2}/g, '').trim();
    const words = nm.split(/\s+/).filter(Boolean);
    while (words.length > 2 && (words[words.length - 1].length <= 2 || /^[A-ZÄÖÜ]{2,3}$/.test(words[words.length - 1]))) words.pop();
    nm = words.filter(w => !(w.length === 1)).join(' ');
    if (/^[A-Za-zÄÖÜäöüéèàç.' \-]{3,40}$/.test(nm) && !streetWord.test(nm)) out.name = nm;
  }

  // 6) Lieferzeit: „Lieferzeit 20:30“, sonst Uhrzeit auf der Namenszeile / im Kopf, sonst „Lieferdatum … 20:30“
  let lt = text.match(/lieferzeit\D{0,25}(\d{1,2})[:.](\d{2})/i);
  if (!lt) {
    const head = all.slice(0, Math.max(0, anchor) + (si >= 0 ? si + 2 : 6));
    for (const l of head) { if (isDate(l)) continue; const m = l.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/); if (m) { lt = m; break; } }
  }
  if (!lt) lt = text.match(/lieferdatum[^\n]*?(\d{1,2}):(\d{2})/i);
  if (lt && +lt[1] < 24) out.time = `${String(lt[1]).padStart(2, '0')}:${lt[2]}`;

  // 7) Bezahlt?
  if (/nichts\s*einkassieren|online\s*bez|bezahlt\s*:?\s*online|bereits\s*bezahlt|twint/i.test(text)) out.pay = 'online';
  else if (/kartenzahlung|mit\s*karte|kreditkarte|debitkarte/i.test(text)) out.pay = 'karte';
  else if (/barzahlung|\bbar\b|zu\s*bezahlen/i.test(text)) out.pay = 'bar';

  // 8) Betrag = grösster Geldbetrag (das Total), Referenznummer gegen doppelte Zettel
  const nums = (lines.join('\n').match(/\d{1,4}[.,]\d{2}(?!\.\d)/g) || []).map(n => +n.replace(',', '.')).filter(n => n > 0 && n < 2000);
  if (nums.length) out.amount = fr(Math.max(...nums));
  const rf = text.match(/\b(?:ref|rat|rof|rel)\.?\s*:?\s*(\d{5,})/i); if (rf) out.ref = rf[1];

  // 9) Ort angleichen + Sicherung: niemals die Subito-Adresse als Kunde
  out.ort = matchOrt(out.ort, out.plz);
  if (/^kantons?.?str/i.test(norm(out.street)) && /^24\b/.test(out.street.replace(/^\D+/, '')) || (out.plz === '7302' && /kanton/i.test(out.street))) {
    out.street = ''; out.plz = ''; out.ort = '';
  }
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

async function optimizeTour(quiet) {
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
  if (!quiet) toast('Berechne beste Reihenfolge…', 8000);
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
    <div class="summary">
      <div class="stat"><b>${open.length}</b><small>offen</small></div>
      <div class="stat"><b>${fr(sum)}</b><small>CHF total</small></div>
      <div class="stat"><b>${fr(cash)}</b><small>CHF bar kassieren</small></div>
    </div>
    ${lastRoute && open.length ? `<p class="hint">Route: ca. ${Math.round(lastRoute.dur * driveFactor() / 60)} Min · ${(lastRoute.dist / 1000).toFixed(1)} km${db.learn?.driveN ? ` · gelernt: du fährst ${Math.round((driveFactor() - 1) * 100) >= 0 ? '+' : ''}${Math.round((driveFactor() - 1) * 100)} % gegenüber Berechnung` : ''}</p>
` : ''}
    <div class="row">
      <button class="btn primary big" data-act="scan" type="button">📷 Scannen</button>
      <button class="btn" data-act="add" type="button">＋ Von Hand</button>
    </div>
    ${open.length ? `<button class="btn dark block mt big" data-act="go" type="button">🚗 Los – Navi zum 1. Stopp</button>` : ''}
    ${open.length && !lastRoute ? '<button class="btn block mt" data-act="opt" type="button">⚡ Route berechnen</button>' : ''}
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
    scan: () => scanDialog(),
    go: () => goTour(),
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

// ---------- Schnell-Scan: mehrere Zettel → automatisch eine Tour ----------
// Jeder Zettel wird sofort gelesen und übernommen; danach wird die Route automatisch berechnet.
function isDuplicate(p) {
  return db.tour.some(o => !o.done && (
    (p.ref && o.ref === p.ref) ||
    (norm(db.customers[o.custId]?.street) === norm(p.street) && (o.time || '') === (p.time || '') && (+o.amount || 0) === (+p.amount || 0))
  ));
}
async function addOrderFromParsed(p) {
  const ort = p.ort || db.settings.lastOrt;
  const c = upsertCustomer({ street: p.street, plz: p.plz, ort, phone: p.phone, name: p.name });
  db.settings.lastOrt = ort;
  const o = { id: uid(), custId: c.id, amount: p.amount || '0', pay: p.pay || 'bar',
    note: p.etage && p.etage !== '0' ? `Etage ${p.etage}` : '', time: p.time || '', ref: p.ref || '', done: false, addedAt: Date.now() };
  db.tour.push(o); save();
  if (c.lat == null) {
    const g = await geocode(c.street, c.plz, c.ort);
    if (g) { c.lat = g.lat; c.lng = g.lng; c.approx = g.approx; save(); }
  }
  return { o, c };
}
// Route automatisch (kurz warten, falls gleich noch ein Zettel kommt)
let autoRouteTimer = null;
function autoRoute(delay = 600) {
  clearTimeout(autoRouteTimer);
  return new Promise(res => {
    autoRouteTimer = setTimeout(async () => {
      if (openStops().some(o => target(db.customers[o.custId])) && db.settings.base) await optimizeTour(true);
      res();
    }, delay);
  });
}

function scanDialog() {
  const d = openDialog(`
    <h3>Zettel scannen</h3>
    <p class="hint">Ein Zettel nach dem anderen. Jeder kommt automatisch in die Tour, die Route rechnet sich selbst.</p>
    <div class="bigbtns">
      <label class="btn primary">📷 Zettel fotografieren<input id="sCam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn">🖼️ Mehrere aus Fotos wählen<input id="sLib" type="file" accept="image/*" multiple hidden></label>
    </div>
    <div id="sList" class="list mt"></div>
    <p class="hint" id="sRoute"></p>
    <div class="foot">
      <button class="btn" value="cancel" type="submit">Fertig</button>
      <button class="btn dark" id="sGo" type="button" disabled>🚗 Los</button>
    </div>`);
  const list = $('#sList', d), go = $('#sGo', d), routeInfo = $('#sRoute', d);
  let busy = 0, added = 0;
  const refresh = () => {
    const n = openStops().length;
    go.disabled = busy > 0 || !n;
    go.textContent = busy ? '⏳ Lese…' : `🚗 Los · ${n}`;
    if (lastRoute && n && !busy) {
      const late = openStops().filter(o => lateBy(o) > 0).length;
      routeInfo.innerHTML = `Route: ca. <b>${Math.round(lastRoute.dur * driveFactor() / 60)} Min</b> · ${(lastRoute.dist / 1000).toFixed(1)} km · ${late ? `<span class="warn">⚠️ ${late}× zu spät</span>` : 'alle pünktlich ✓'}`;
    }
  };
  const handle = async files => {
    for (const file of files) {
      busy++; refresh();
      const row = document.createElement('div'); row.className = 'scanitem'; row.innerHTML = '<span class="spin"></span> Lese Zettel…';
      list.prepend(row);
      try {
        const p = parseOrder(await ocr(file, s => { row.innerHTML = `<span class="spin"></span> ${esc(s)}`; }));
        if (!p.street) {
          row.className = 'scanitem bad';
          row.innerHTML = `⚠️ Adresse nicht erkannt <button class="btn sm" type="button">Von Hand</button>`;
          $('button', row).onclick = () => orderDialog(p);
        } else if (isDuplicate(p)) {
          row.className = 'scanitem dup'; row.innerHTML = `↺ ${esc(p.street)} – schon in der Tour`;
        } else {
          row.innerHTML = `<span class="spin"></span> ${esc(p.street)} – suche auf Karte…`;
          const { o, c } = await addOrderFromParsed(p);
          added++;
          row.className = 'scanitem ok';
          row.innerHTML = `<b>✓ ${esc(c.street)}</b>, ${esc(c.ort)}<br><small>${o.time ? `🕗 ${esc(o.time)} · ` : ''}CHF ${fr(o.amount)} · ${payLabel(o.pay)}${c.lat == null ? ' · <span class="warn">⚠️ Punkt fehlt</span>' : c.approx ? ' · <span class="warn">Punkt ungefähr</span>' : ''}</small>`;
        }
      } catch (err) {
        row.className = 'scanitem bad'; row.textContent = '⚠️ Konnte das Foto nicht lesen (Internet beim ersten Mal nötig)';
      }
      busy--; refresh();
    }
    if (added) { routeInfo.textContent = 'Berechne beste Route…'; await autoRoute(300); refresh(); }
  };
  $('#sCam', d).addEventListener('change', e => { handle([...e.target.files]); e.target.value = ''; });
  $('#sLib', d).addEventListener('change', e => { handle([...e.target.files]); e.target.value = ''; });
  go.addEventListener('click', () => { closeDialog(); goTour(); });
  refresh();
}

// „Los“: Zeiten ab jetzt, Navi zum ersten Stopp sofort öffnen
function goTour() {
  const first = openStops()[0]; if (!first) return;
  if (lastRoute) departNow();
  const t = target(db.customers[first.custId]);
  if (t) window.open(navUrl(t), '_blank');
  setTimeout(nextStopDialog, 500);
}

// ---------- Dialoge ----------
function openDialog(html) {
  const d = $('#dlg');
  d.innerHTML = `<form method="dialog" class="dlg">${html}</form>`;
  d.showModal();
  return d;
}
const closeDialog = () => $('#dlg').close();

function orderDialog(prefill) {
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
  if (prefill) setTimeout(() => fill(prefill), 0);
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
    autoRoute();
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

// ---------- Karte: 3D mit MapLibre (gratis, ohne Schlüssel) ----------
// 3D = OpenFreeMap (3D-Häuser, Hausnummern, Läden) · Satellit = swisstopo Luftbild + Namen + 3D-Berge
// Schweiz = swisstopo Detailkarte
const MAP_STYLES = {
  '3D': 'https://tiles.openfreemap.org/styles/liberty',
  'Satellit': 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.imagerybasemap.vt/style.json',
  'Schweiz': 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json'
};
const NEON = '#8DDD58';
let map = null, meMarker = null, pick = null, watchId = null, pins = [];

function initMap() {
  const b = db.settings.base;
  if (!MAP_STYLES[db.settings.mapStyle]) db.settings.mapStyle = '3D';
  map = new maplibregl.Map({
    container: 'map', style: MAP_STYLES[db.settings.mapStyle],
    center: b ? [b.lng, b.lat] : [9.56, 46.96], zoom: 14, pitch: 55, bearing: -20, maxPitch: 80,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
  map.on('style.load', () => { styleExtras(); drawRoute(); });
  map.on('load', drawRoute);
  map.on('click', e => {
    if (!pick) return;
    const c = db.customers[pick.custId]; if (!c) return endPick();
    const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    if (pick.kind === 'house') { c.lat = p.lat; c.lng = p.lng; c.approx = false; } else c[pick.kind] = p;
    save(); const id = c.id; endPick(); drawMap(); renderTour(); toast('Punkt gespeichert ✓');
    setTimeout(() => customerDialog(id), 400);
  });
  $('#btnMe').addEventListener('click', async () => {
    try { const p = await gps(); showMe(p); map.flyTo({ center: [p.lng, p.lat], zoom: 18, pitch: 60 }); } catch (e) { toast('GPS nicht verfügbar'); }
  });
  $('#btnFit').addEventListener('click', fitTour);
  $('#mapStyles').addEventListener('click', e => {
    const b2 = e.target.closest('[data-style]'); if (!b2) return;
    db.settings.mapStyle = b2.dataset.style; save(); markStyleBtn();
    map.setStyle(MAP_STYLES[b2.dataset.style], { diff: false });
    map.once('idle', () => { styleExtras(); drawRoute(); }); // Sicherheitsnetz
  });
  markStyleBtn();
  drawMap();
}
function markStyleBtn() { $$('#mapStyles [data-style]').forEach(x => x.classList.toggle('on', x.dataset.style === db.settings.mapStyle)); }

// Nach jedem Stilwechsel: 3D-Berge (Satellit), 3D-Häuser sicher an
function styleExtras() {
  try {
    if (db.settings.mapStyle === 'Satellit') {
      if (!map.getSource('dem')) map.addSource('dem', {
        type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Höhen: Mapzen/AWS'
      });
      map.setTerrain({ source: 'dem', exaggeration: 1.3 });
    } else map.setTerrain(null);
  } catch (e) { /* Gelände optional */ }
}

// Route als leuchtende Linie
function drawRoute() {
  if (!map) return;
  try { drawRouteNow(); } catch (e) { map.once('idle', () => { try { drawRouteNow(); } catch (e2) { /* später */ } }); }
}
function drawRouteNow() {
  const data = lastRoute && openStops().length ? { type: 'Feature', properties: {}, geometry: lastRoute.geo } : { type: 'FeatureCollection', features: [] };
  if (map.getSource('route')) { map.getSource('route').setData(data); return; }
  map.addSource('route', { type: 'geojson', data });
  map.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': NEON, 'line-width': 16, 'line-opacity': 0.25, 'line-blur': 6 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#14210F', 'line-width': 8 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': NEON, 'line-width': 5 } });
}

function pin(p, cls, txt, html) {
  const el = document.createElement('div'); el.className = `pin ${cls}`; el.textContent = txt;
  const m = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]);
  if (html) m.setPopup(new maplibregl.Popup({ offset: 18, maxWidth: '270px', closeButton: false }).setHTML(html));
  m.addTo(map); pins.push(m); return m;
}
function showMe(p) {
  if (!map) return;
  if (!meMarker) { const el = document.createElement('div'); el.className = 'pin me'; meMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map); }
  else meMarker.setLngLat([p.lng, p.lat]);
}
function drawMap() {
  if (!map) return;
  pins.forEach(m => m.remove()); pins = [];
  const b = db.settings.base;
  if (b) pin(b, 'base', '🍕', `<b>${SUBITO.name}</b><br>${SUBITO.street}, ${SUBITO.plz} ${SUBITO.ort}`);
  const tourIds = new Set();
  Object.values(db.customers).forEach(c => {
    if (c.lat == null || openStops().some(o => o.custId === c.id)) return;
    pin({ lat: c.lat, lng: c.lng }, 'cust', '', popup(c));
  });
  openStops().forEach((o, i) => {
    const c = db.customers[o.custId]; if (!c) return; tourIds.add(c.id);
    if (c.park) pin(c.park, 'park', 'P', `🅿️ Parkplatz · ${esc(c.street)}<br><a href="${navUrl(c.park)}" target="_blank" rel="noopener">🧭 Hierhin navigieren</a>`);
    if (c.bell) pin(c.bell, 'bell', '🔔', `🔔 Klingel/Eingang · ${esc(c.street)}`);
    if (c.lat != null) pin({ lat: c.lat, lng: c.lng }, 'stop' + (lateBy(o) > 0 ? ' late' : ''), String(i + 1), popup(c, o));
  });
  drawRoute();
}
function popup(c, o) {
  const t = target(c), eta = o && lastRoute?.eta?.[o.id];
  return `<b>${esc(c.street)}</b>${c.name ? ` · ${esc(c.name)}` : ''}<br>${esc(c.plz)} ${esc(c.ort)}
    ${o ? `<br>CHF ${fr(o.amount)} · ${payLabel(o.pay)}${o.time ? ` · 🕗 ${esc(o.time)}` : ''}${eta ? ` · an ${tm(eta)}` : ''}` : ''}
    ${(c.tags || []).length ? `<br>⚠️ ${c.tags.map(esc).join(', ')}` : ''}
    ${c.notes ? `<br>📝 ${esc(c.notes)}` : ''}
    <div class="pop-btns">${t ? `<a class="btn sm primary" href="${navUrl(t)}" target="_blank" rel="noopener">🧭 Navi</a>` : ''}${c.phone ? `<a class="btn sm call" href="tel:${esc(c.phone)}">📞</a>` : ''}<a class="btn sm" href="#" data-cust="${esc(c.id)}">Kunde</a></div>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-cust]'); if (!a) return;
  e.preventDefault(); customerDialog(a.dataset.cust);
});
function fitTour() {
  if (!map) return;
  const pts = [];
  if (db.settings.base) pts.push([db.settings.base.lng, db.settings.base.lat]);
  openStops().forEach(o => { const c = db.customers[o.custId]; if (c && c.lat != null) pts.push([c.lng, c.lat]); });
  if (lastRoute?.geo?.coordinates) lastRoute.geo.coordinates.forEach(x => pts.push(x));
  if (pts.length > 1) {
    const bb = pts.reduce((bnd, p) => bnd.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(bb, { padding: { top: 90, bottom: 60, left: 50, right: 50 }, pitch: 45, maxZoom: 16, duration: 900 });
  } else if (pts.length) map.flyTo({ center: pts[0], zoom: 16, pitch: 55 });
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
  // Zum genauen Tippen: flach und nah
  if (p) setTimeout(() => map.flyTo({ center: [p.lng, p.lat], zoom: 19, pitch: 0, bearing: 0, duration: 800 }), 100);
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
    if (!map) initMap(); else { map.resize(); drawMap(); }
    if (!pick && openStops().length) setTimeout(fitTour, 400);
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
