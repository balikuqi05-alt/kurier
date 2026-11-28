'use strict';
/* Subito Kurier v10 – persönliche Liefer-App (Subito Pizzakurier, Landquart).
   Karte: search.ch · Adressen: Photon/Nominatim · Routen-Planung: OSRM · Texterkennung: Tesseract (auf dem Handy)
   Alle Kundendaten bleiben nur auf diesem Handy (localStorage). */
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


// ---------- Speicher ----------
const KEY = 'kurier.v1';
const EMPTY = {
  settings: { base: null, roundtrip: false, navApp: 'google', startFromGps: false, lastOrt: 'Landquart' },
  customers: {}, tour: [], shifts: [], activeShift: null
};
let db = loadDb();
if (!db.settings.v6) { db.settings.roundtrip = false; db.settings.v6 = true; db.route = null; } // v6: Route nur bis zur Lieferung
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
  // Schnell zuerst: Photon (keine Wartezeit). Nur übernehmen, wenn die Hausnummer genau stimmt.
  try {
    const b = db.settings.base || { lat: 46.96, lng: 9.56 };
    const r = await fetch(`https://photon.komoot.io/api/?q=${enc([street, [plz, ort].filter(Boolean).join(' ')].filter(Boolean).join(', '))}&limit=4&lang=de&lat=${b.lat}&lon=${b.lng}`);
    const j = await r.json();
    const hn = ((street || '').match(/(\d+\s?[a-z]?)\s*$/i) || ['', ''])[1].replace(/\s/g, '').toLowerCase();
    const f = (j.features || []).find(x => {
      const p = x.properties || {};
      return p.countrycode === 'CH' && hn && String(p.housenumber || '').toLowerCase() === hn &&
        (!plz || p.postcode === plz) && norm(p.street || p.name || '').slice(0, 5) === norm(street).slice(0, 5);
    });
    if (f) return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], approx: false };
  } catch (e) { /* weiter mit Nominatim */ }
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
  if (!ocrWorker) { onStatus('Starte Texterkennung…'); ocrWorker = Tesseract.createWorker('deu'); ocrWorker.catch(() => { ocrWorker = null; }); }
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
  const streetRe = /([A-Za-zÄÖÜäöüéèàç.\-' ]{3,40}?)\s+(\d{1,4}[a-zA-Z]?)\b/;
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
  if (si >= 0) { const m = lines[si].match(streetRe); out.street = cleanStreet(`${m[1].trim()} ${m[2]}`); }
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
    while (words.length > 2 && words[0].length <= 2 && !/\.$/.test(words[0])) words.shift();
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

  // 9) Bestellte Produkte (mit Bildern von subitopizzakurier.ch)
  out.items = parseItems(all);

  // 10) Ort angleichen + Sicherung: niemals die Subito-Adresse als Kunde
  out.ort = matchOrt(out.ort, out.plz);
  if (/^kantons?.?str/i.test(norm(out.street)) && /^24\b/.test(out.street.replace(/^\D+/, '')) || (out.plz === '7302' && /kanton/i.test(out.street))) {
    out.street = ''; out.plz = ''; out.ort = '';
  }
  return out;
}

// Strasse säubern: OCR-Krümel vorne, falsche Endungen
function cleanStreet(st) {
  let w = st.replace(/\s+/g, ' ').trim().split(' ');
  while (w.length > 2 && w[0].length <= 2 && !/\.$/.test(w[0])) w.shift();
  st = w.join(' ');
  return st.replace(/strass\b/i, 'strasse').replace(/strase\b/i, 'strasse').replace(/str\b(?!\.)/i, 'str.');
}

// ---------- Produkte auf dem Zettel erkennen ----------
// Zeilen wie „1 KEBAB 12.90 12.90“, darunter Zusätze („Knoblauch Sauce“). Stopp bei Zwischensumme/Total.
function parseItems(all) {
  const items = [];
  const stop = /zwischensumme|^total|ergänzung|erganzung|bezahlt|zu\s*bezahlen|mindestbestell/i;
  const head = /^\s*(\d{1,2})\s*[x×*]?\s+(.+)$/;
  let started = false;
  for (const raw of all) {
    const l = raw.replace(/\s+/g, ' ').trim();
    if (started && stop.test(l)) break;
    const m = l.match(head);
    if (m && +m[1] > 0 && +m[1] < 30 && !/^\d{4}\b/.test(l)) {
      let name = m[2].replace(/(\s*-?\d+[.,]\d{2})+\s*$/, '').replace(/[^A-Za-zÄÖÜäöüéèàç0-9'&.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (name.length < 3 || !/[A-Za-zÄÖÜäöü]{3}/.test(name)) continue;
      const prod = matchProduct(name);
      if (!prod && !started) continue;           // vor der ersten echten Zeile nichts raten
      started = true;
      items.push({ q: +m[1], n: prod ? prod.n : titleCase(name), img: prod ? prod.img : '', c: prod ? prod.c : '', opt: '' });
      continue;
    }
    // Zusatz-Zeile unter einem Produkt (z. B. „Knoblauch Sauce“)
    if (started && items.length && /^[^\d]{3,40}$/.test(l) && !stop.test(l)) {
      const ow = l.split(' ');
      while (ow.length > 1 && (ow[0].length <= 2 || !/[A-Za-zÄÖÜäöü]/.test(ow[0]))) ow.shift();
      const opt = ow.join(' ').replace(/[^A-Za-zÄÖÜäöüéèàç0-9'&.\- ]/g, '').trim();
      if (opt.length >= 3 && /[a-zäöü]{3}/i.test(opt)) { const it = items[items.length - 1]; it.opt = it.opt ? it.opt + ', ' + opt : opt; }
    }
  }
  return items;
}
const titleCase = s => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
// Produkt aus der Speisekarte finden (tolerant gegenüber OCR-Fehlern)
const FILL = /\b(pizza|pizzas|normal|klein|gross|familie|family|portion|stk|stueck|mit|und|extra)\b/g;
const sizeNorm = s => s.replace(/\b0[.,]?5\s?l\b/g, '50cl').replace(/\b1[.,]5\s?l\b/g, '150cl').replace(/\b0[.,]?33\s?l\b/g, '33cl');
function matchProduct(name) {
  if (typeof PRODUCTS === 'undefined') return null;
  const nn = norm(sizeNorm(name.toLowerCase())).replace(FILL, ' ').replace(/\s+/g, ' ').trim();
  if (!nn) return null;
  let best = null, bs = 0;
  for (const p of PRODUCTS) {
    const pn = norm(p.n).replace(FILL, ' ').replace(/\s+/g, ' ').trim() || norm(p.n);
    let sc = 0;
    if (norm(p.n) === norm(sizeNorm(name.toLowerCase()))) sc = 130;   // genau gleicher Name gewinnt immer
    else if (pn === nn) sc = 100 - (norm(p.n).split(' ').length - pn.split(' ').length) * 8;
    else if (nn.startsWith(pn + ' ') || nn === pn) sc = 70 + pn.length;           // „kebab scharf extra“ → „Kebab scharf“
    else if (pn.startsWith(nn)) sc = 60 + nn.length;
    else {
      const a = new Set(nn.split(' ')), b = pn.split(' ');
      const hit = b.filter(w => a.has(w) || [...a].some(x => x.length > 3 && lev(x, w) <= 1)).length;
      // wie viele Wörter des Produkts sind auf dem Zettel? (Zusatzwörter kosten wenig)
      sc = hit / b.length * 70 - Math.max(0, a.size - hit) * 4;
      const d = lev(nn, pn); if (d <= Math.max(1, Math.floor(pn.length / 5))) sc = Math.max(sc, 85 - d * 5);
    }
    if (sc > bs) { bs = sc; best = p; }
  }
  return bs >= 45 ? best : null;
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
async function osrmRoute(pts, steps) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${osrmCoords(pts)}?overview=full&geometries=geojson${steps ? '&steps=true' : ''}`);
  const j = await r.json(); if (j.code !== 'Ok') throw new Error(j.code);
  const rt = j.routes[0];
  return { geo: rt.geometry, legs: rt.legs.map(l => l.duration), legDist: rt.legs.map(l => l.distance), dist: rt.distance, dur: rt.duration, steps: steps ? rt.legs[0].steps : null };
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
    note: p.etage && p.etage !== '0' ? `Etage ${p.etage}` : '', time: p.time || '', ref: p.ref || '', items: p.items || [], done: false, addedAt: Date.now() };
  db.tour.push(o); save();
  if (c.lat == null) {
    const g = await geocode(c.street, c.plz, c.ort);
    if (g) { c.lat = g.lat; c.lng = g.lng; c.approx = g.approx; save(); }
  }
  return { o, c };
}
// Route automatisch (kurz warten, falls gleich noch ein Zettel kommt)
let autoRouteTimer = null, autoRouteWaiting = [];
function autoRoute(delay = 600) {
  clearTimeout(autoRouteTimer);
  return new Promise(res => {
    autoRouteWaiting.push(res);
    autoRouteTimer = setTimeout(async () => {
      const waiting = autoRouteWaiting; autoRouteWaiting = [];
      try { if (openStops().some(o => target(db.customers[o.custId])) && db.settings.base) await optimizeTour(true); } catch (e) { /* weiter */ }
      waiting.forEach(r => r());
    }, delay);
  });
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
    if (lastSearchPoint && norm(lastSearchPoint.street) === norm(street) && c.lat == null) { c.lat = lastSearchPoint.lat; c.lng = lastSearchPoint.lng; c.approx = false; }
    lastSearchPoint = null; if (searchPin && smap) { killPoi(searchPin); searchPin = null; live.target = null; }
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
    ${itemsHtml(o.items, true)}
    ${isCash ? `
      <label class="f">💵 Kunde gibt CHF</label>
      <div class="tips">${gives.map(v => `<button type="button" data-give="${v}">${v === amt ? 'Genau' : v}</button>`).join('')}</div>
      <input id="dGive" class="mt" inputmode="decimal" placeholder="anderer Betrag">
      <div class="change" id="dChange">Wähle, was der Kunde gibt</div>
      <div class="row" id="dKeepRow" hidden>
        <button class="btn sm" id="dKeep" type="button">„Stimmt so“ – Rest ist Trinkgeld</button>
        <button class="btn sm" id="dRound" type="button"></button>
      </div>` : ''}
    <label class="f">Trinkgeld CHF${isCash ? '' : ' – antippen = fertig'}</label>
    <div class="tips">${[0, 1, 2, 3, 5].map(v => `<button type="button" data-tip="${v}">${v === 0 ? 'Keins' : v}</button>`).join('')}</div>
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
  $$('[data-tip]', d).forEach(b => b.addEventListener('click', () => { setTip(b.dataset.tip); if (!isCash) $('#dOk', d).click(); }));
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
        const p = lastPos && Date.now() - (lastPos.t || 0) < 30000 ? lastPos : await gps();
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
    afterDelivered();
  });
}

// Nach „Geliefert“: nächster Kunde mit grossem Navi- und Anrufen-Knopf
function nextStopDialog() {
  const o = openStops()[0];
  if (!o) {
    const b = db.settings.base;
    openDialog(`<h3>Tour fertig! 🎉</h3><p class="sub">Alle Bestellungen geliefert.</p>
      <div class="foot">${b ? `<button class="btn primary" type="button" ${navPt(b, 'Subito')}>🍕 Zurück zu Subito</button>` : ''}
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
      ${t ? `<button class="btn primary" type="button" data-nav="${o.id}">🧭 Navi starten</button>` : ''}
      ${c.phone ? `<a class="btn call" href="tel:${esc(c.phone)}">📞 Anrufen</a>` : ''}
      <button class="btn" value="cancel" type="submit">Später</button>
    </div>`);
}

// ---------- Schicht & Abrechnung ----------
function ensureShift() {
  let s = db.shifts.find(x => x.id === db.activeShift);
  if (!s) { s = { id: uid(), start: Date.now(), end: null, deliveries: [] }; db.shifts.push(s); db.activeShift = s.id; }
  return s;
}
function totals(dels) {
  return dels.reduce((a, d) => ({ n: a.n + 1, amount: a.amount + d.amount, tip: a.tip + d.tip, cash: a.cash + (d.pay === 'bar' ? d.amount : 0) }), { n: 0, amount: 0, tip: 0, cash: 0 });
}
// ---------- Ansicht: Kasse (einfach: oben das Wichtigste, Rest zum Aufklappen) ----------
function renderSchicht() {
  const v = $('#view-schicht');
  const act = db.shifts.find(x => x.id === db.activeShift);
  const now = new Date();
  const sameMonth = t => { const x = new Date(t); return x.getMonth() === now.getMonth() && x.getFullYear() === now.getFullYear(); };
  const m = totals(db.shifts.flatMap(s => s.deliveries).filter(d => sameMonth(d.t)));
  const monthHours = db.shifts.filter(s => sameMonth(s.start)).reduce((a, s) => a + ((s.end || Date.now()) - s.start) / 3.6e6, 0);
  const t = act ? totals(act.deliveries) : null;
  v.innerHTML = `
    <h1 class="vh">Kasse</h1>
    ${act ? `
      <div class="hero">
        <small>Bar an Subito abgeben</small>
        <b>CHF ${fr(t.cash)}</b>
        <div class="hero-row"><span>${t.n} Lieferungen</span><span>Trinkgeld <b>${fr(t.tip)}</b></span></div>
      </div>
      <details class="acc"><summary>💵 Kassensturz</summary>
        <label class="f" for="shFloat">Wechselgeld am Anfang (CHF)</label>
        <input id="shFloat" inputmode="decimal" value="${act.float ? fr(act.float) : ''}" placeholder="z. B. 100">
        <table class="t mt">
          <tr><td>Wechselgeld</td><td class="r">${fr(act.float)}</td></tr>
          <tr><td>+ Bar kassiert</td><td class="r">${fr(t.cash)}</td></tr>
          <tr><td>+ Trinkgeld</td><td class="r">${fr(t.tip)}</td></tr>
          <tr><th>= In der Tasche</th><th class="r">${fr((+act.float || 0) + t.cash + t.tip)}</th></tr>
        </table>
        <p class="hint">Seit ${tm(act.start)} · Umsatz CHF ${fr(t.amount)}</p>
      </details>
      <button class="btn block big mt" data-act="end" type="button">Schicht beenden</button>`
    : `<div class="hero light"><small>Heute</small><b>Noch keine Lieferung</b><div class="hero-row"><span>Die Schicht startet automatisch bei der ersten Lieferung.</span></div></div>`}
    <details class="acc"><summary>📅 Diesen Monat · ${m.n} Lieferungen</summary>
      <div class="summary">
        <div class="stat"><b>${fr(m.amount)}</b><small>Umsatz</small></div>
        <div class="stat"><b>${fr(m.tip)}</b><small>Trinkgeld</small></div>
        <div class="stat"><b>${monthHours > 0.1 ? fr(m.tip / monthHours) : '–'}</b><small>Trinkgeld/Std.</small></div>
      </div>
      ${db.shifts.length ? `<table class="t mt"><tr><th>Datum</th><th class="r">Lief.</th><th class="r">Trinkg.</th></tr>
        ${db.shifts.slice(-12).reverse().map(s => { const x = totals(s.deliveries); return `<tr><td>${dt(s.start)}</td><td class="r">${x.n}</td><td class="r">${fr(x.tip)}</td></tr>`; }).join('')}</table>` : ''}
      <button class="btn block mt" data-act="csv" type="button">Als Tabelle exportieren</button>
    </details>`;
}
$('#view-schicht').addEventListener('change', e => {
  if (e.target.id !== 'shFloat') return;
  const s = db.shifts.find(x => x.id === db.activeShift); if (!s) return;
  s.float = +e.target.value.replace(',', '.') || 0; save(); renderSchicht();
  const d = $('#view-schicht details'); if (d) d.open = true;
});
$('#view-schicht').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'end') {
    const s = db.shifts.find(x => x.id === db.activeShift); if (!s) return;
    const t = totals(s.deliveries);
    if (!confirm(`Schicht beenden?\n${t.n} Lieferungen · Trinkgeld CHF ${fr(t.tip)}\nBar an Subito abgeben: CHF ${fr(t.cash)}`)) return;
    s.end = Date.now(); db.activeShift = null; db.tour = openStops(); save(); renderSchicht(); renderTour();
  }
  if (b.dataset.act === 'csv') {
    const rows = [['Datum', 'Zeit', 'Ort', 'Betrag', 'Zahlung', 'Trinkgeld']];
    // Datenschutz: nur Ort, keine Strasse/Namen in der Tabelle
    db.shifts.forEach(s => s.deliveries.forEach(d => rows.push([dt(d.t), tm(d.t), (d.addr || '').split(',').pop().trim(), fr(d.amount), payLabel(d.pay), fr(d.tip)])));
    download('subito-lieferungen.csv', rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
  }
});
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Ansicht: Mehr (einfaches Menü zum Aufklappen) ----------
function renderEinst() {
  const s = db.settings;
  const v = $('#view-einst');
  const nCust = Object.keys(db.customers).length;
  v.innerHTML = `
    <h1 class="vh">Mehr</h1>
    <button class="menu-row" type="button" data-open-kunden><span>👤</span><b>Kunden & Notizen</b><small>${nCust}</small><i>›</i></button>
    <details class="acc"><summary>🔒 Datenschutz & Sperre</summary>
      <div class="priv">
        <p><b>Kundendaten bleiben auf diesem Handy.</b> Namen, Telefonnummern, Notizen und Zettel-Fotos werden nirgends hochgeladen. Die Texterkennung läuft direkt auf dem Handy.</p>
        <p class="hint">Ins Internet geht nur, was für Karte und Route nötig ist: die <b>Adresse</b> (search.ch, Photon) und Koordinaten (OSRM) – nie Name oder Telefon.</p>
      </div>
      <label class="f">App-Sperre mit PIN</label>
      <div class="row">${s.pinHash
        ? '<button class="btn" data-act="pinchange" type="button">PIN ändern</button><button class="btn danger" data-act="pinoff" type="button">Sperre aus</button>'
        : '<button class="btn primary" data-act="pinset" type="button">🔒 PIN festlegen</button>'}</div>
      <p class="hint">Sperrt die App beim Öffnen und nach 5 Minuten im Hintergrund.</p>
      <label class="f" for="sKeep">Kundendaten automatisch löschen nach</label>
      <select id="sKeep">
        ${[[30, '30 Tagen ohne Lieferung'], [90, '90 Tagen ohne Lieferung'], [180, '180 Tagen ohne Lieferung'], [0, 'nie']].map(([d, l]) => `<option value="${d}" ${(s.keepDays ?? 90) === d ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <p class="hint">Alte Lieferungen behalten nur Betrag & Trinkgeld, die Adresse wird entfernt.</p>
      <button class="btn danger block mt" data-act="wipe" type="button">Alle Daten löschen</button>
    </details>
    <details class="acc"><summary>💾 Backup</summary>
      <p class="hint">Das Backup enthält Kundendaten – nur auf deinem eigenen Handy/Mac speichern, nicht weiterschicken.</p>
      <div class="row">
        <button class="btn" data-act="backup" type="button">Speichern</button>
        <label class="btn">Laden<input type="file" id="sImport" accept="application/json" hidden></label>
      </div>
    </details>
    <details class="acc"><summary>🍕 Subito & Route</summary>
      <p class="hint">${SUBITO.name}, ${SUBITO.street}, ${SUBITO.plz} ${SUBITO.ort} · <a href="tel:${SUBITO.phone}">081 322 20 20</a><br>${s.base ? '✓ Standort gesetzt' : '⚠️ Standort fehlt'}</p>
      <div class="row">
        <button class="btn sm" data-act="basegeo" type="button">Adresse suchen</button>
        <button class="btn sm" data-act="basegps" type="button">Ich bin bei Subito</button>
      </div>
      <label class="toggle"><input type="checkbox" id="sRound" ${s.roundtrip ? 'checked' : ''}> Rückfahrt zu Subito in der Planung mitrechnen</label>
      <p class="hint">Gelernt: Fahrtempo ${db.learn?.driveN ? `${Math.round((driveFactor() - 1) * 100)} % (aus ${db.learn.driveN} Fahrten)` : 'noch offen'} · Übergabe Ø ${fr(svcMin(null)).replace('.00', '')} Min</p>
    </details>
    <details class="acc"><summary>📍 Liefergebiet</summary>
      <table class="t">${Object.entries(ORTE).map(([o, m]) => `<tr><td>${esc(o)}</td><td class="r">ab ${m}.–</td></tr>`).join('')}</table>
    </details>
    <p class="hint credits">Karte © search.ch, swisstopo · Adressen © OpenStreetMap (Photon/Nominatim) · Routenplanung OSRM</p>`;
  $('#sRound', v).onchange = e => { s.roundtrip = e.target.checked; save(); };
  $('#sKeep', v).onchange = e => { s.keepDays = +e.target.value; save(); const n = applyRetention(); toast(n ? `${n} alte Kunden gelöscht` : 'Gespeichert ✓'); };
  $('#sImport', v).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.customers || !d.shifts) throw new Error();
      if (!confirm('Backup laden? Die aktuellen Daten werden ersetzt.')) return;
      db = { ...structuredClone(EMPTY), ...d, settings: { ...EMPTY.settings, ...(d.settings || {}) } }; lastRoute = db.route || null; save(); refreshAll(); toast('Backup geladen ✓');
    } catch (err) { toast('Das ist keine gültige Backup-Datei'); }
  };
}
$('#view-einst').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'basegeo') {
    toast('Suche Subito…');
    const p = await geocode(SUBITO.street, SUBITO.plz, SUBITO.ort);
    if (p) { db.settings.base = p; save(); renderEinst(); drawMap(); toast('Standort gesetzt ✓'); }
    else toast('Nicht gefunden – nimm „Ich bin bei Subito“');
  }
  if (a === 'basegps') {
    try { const p = lastPos && Date.now() - lastPos.t < 60000 ? lastPos : await gps(); db.settings.base = { lat: p.lat, lng: p.lng }; save(); renderEinst(); drawMap(); toast('Standort gesetzt ✓'); }
    catch (err) { toast('GPS nicht verfügbar'); }
  }
  if (a === 'backup') download(`subito-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db), 'application/json');
  if (a === 'wipe' && confirm('Wirklich ALLE Kunden, Notizen und Schichten löschen? Das kann man nicht rückgängig machen.')) {
    const keep = { pinHash: db.settings.pinHash };
    localStorage.removeItem(KEY); db = structuredClone(EMPTY); Object.assign(db.settings, keep); lastRoute = null; save(); refreshAll(); renderEinst(); toast('Alles gelöscht');
  }
  if (a === 'pinset' || a === 'pinchange') setPin();
  if (a === 'pinoff') { const ok = await askPin('Aktuelle PIN'); if (ok) { delete db.settings.pinHash; save(); renderEinst(); toast('Sperre aus'); } }
});

// ---------- Datenschutz: automatisch löschen ----------
function applyRetention() {
  const days = db.settings.keepDays ?? 90; if (!days) return 0;
  const cut = Date.now() - days * 864e5;
  const openIds = new Set(db.tour.map(o => o.custId));
  let n = 0;
  for (const [id, c] of Object.entries(db.customers)) {
    const last = custStats(c).last || c.created || 0;
    if (!openIds.has(id) && last < cut) { delete db.customers[id]; n++; }
  }
  db.shifts.forEach(s => s.deliveries.forEach(d => { if (d.t < cut && (d.addr || d.custId)) { d.addr = ''; d.custId = ''; } }));
  save();
  return n;
}

// ---------- Datenschutz: PIN-Sperre ----------
async function hashPin(pin) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('subito-kurier:' + pin));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Zeigt das PIN-Feld. resolve(pin) oder resolve(null) bei Abbruch
function pinPad(title, cancelable) {
  return new Promise(resolve => {
    const el = $('#lock'); let pin = '';
    el.hidden = false;
    el.innerHTML = `<div class="lk">
      <img src="subito-logo.png" alt="Subito" class="lk-logo">
      <b class="lk-t">${esc(title)}</b>
      <div class="lk-dots">${'<i></i>'.repeat(4)}</div>
      <div class="lk-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map(k => k === '' ? (cancelable ? '<button type="button" data-k="x" class="lk-c">Abbr.</button>' : '<span></span>') : `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>
    </div>`;
    const dots = () => $$('.lk-dots i', el).forEach((d, i) => d.classList.toggle('on', i < pin.length));
    el.onclick = e => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const k = b.dataset.k;
      navigator.vibrate?.(10);
      if (k === 'x') { el.hidden = true; el.onclick = null; resolve(null); return; }
      if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
      dots();
      if (pin.length === 4) setTimeout(() => { el.onclick = null; resolve(pin); }, 120);
    };
  });
}
function lockShake(msg) { const el = $('#lock .lk'); if (!el) return; $('.lk-t', el).textContent = msg; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
async function askPin(title) {
  for (let i = 0; i < 5; i++) {
    const p = await pinPad(i ? 'Falsche PIN – nochmal' : title, true);
    if (p == null) return false;
    if (await hashPin(p) === db.settings.pinHash) { $('#lock').hidden = true; return true; }
  }
  $('#lock').hidden = true; return false;
}
async function setPin() {
  const a = await pinPad('Neue PIN (4 Ziffern)', true); if (a == null) { $('#lock').hidden = true; return; }
  const b = await pinPad('PIN wiederholen', true); if (b == null) { $('#lock').hidden = true; return; }
  $('#lock').hidden = true;
  if (a !== b) { toast('PINs stimmen nicht überein'); return; }
  db.settings.pinHash = await hashPin(a); save(); renderEinst(); toast('🔒 App-Sperre aktiv');
}
let unlocking = false;
async function lockApp() {
  if (!db.settings.pinHash || unlocking) return;
  unlocking = true;
  let wrong = 0;
  for (;;) {
    const p = await pinPad(wrong ? 'Falsche PIN' : 'PIN eingeben', false);
    if (await hashPin(p) === db.settings.pinHash) break;
    wrong++;
    if (wrong >= 5) { $('#lock .lk-t') && ($('#lock .lk-t').textContent = '30 Sekunden warten…'); await sleep(30000); wrong = 0; }
  }
  $('#lock').hidden = true; unlocking = false;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') db.settings.hiddenAt = Date.now(), save();
  else if (db.settings.pinHash && Date.now() - (db.settings.hiddenAt || 0) > 5 * 60000) lockApp();
});

// ---------- Gemeinsame Bausteine (v12 Design) ----------
const ic = (name, fill) => `<i class="${fill ? 'ph-fill' : 'ph-bold'} ph-${name}" aria-hidden="true"></i>`;
const TAG_ICON = {
  'Klingel kaputt – anrufen': 'bell-slash', 'Hintereingang': 'door-open', 'Hund': 'dog', 'Viele Treppen': 'stairs',
  'Kein Lift': 'elevator', 'Name nicht angeschrieben': 'identification-badge', 'Gutes Trinkgeld': 'coins',
  'Zahlt mit Karte': 'credit-card', 'Schwer zu finden': 'map-pin-area', 'Parkieren schwierig': 'traffic-cone'
};
const initials = (c) => {
  const src = (c.name || c.street || '?').replace(/[^A-Za-zÄÖÜäöüéè ]/g, ' ').trim().split(/\s+/);
  return ((src[0] || '?')[0] + (src.length > 1 ? src[src.length - 1][0] : '')).toUpperCase();
};
// Produkte einer Bestellung: runde Subito-Bilder mit Anzahl
function itemsHtml(items, big) {
  if (!items || !items.length) return '';
  return `<div class="items ${big ? 'big' : ''}">${items.map(it => `
    <div class="it">
      <span class="it-img">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy" referrerpolicy="no-referrer-when-downgrade">` : ic('bowl-food')}<b>${it.q}</b></span>
      <span class="it-t"><b>${esc(it.n)}</b>${it.opt ? `<small>${esc(it.opt)}</small>` : ''}</span>
    </div>`).join('')}</div>`;
}
const itemsLine = items => (items || []).map(it => `${it.q}× ${it.n}`).join(' · ');

// Kurze, dezente Meldung oben
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.innerHTML = `${ic('check-circle', true)}<span>${esc(msg)}</span>`; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Kundenfenster (neu) ----------
function customerDialog(id) {
  const c = db.customers[id]; if (!c) return;
  const st = custStats(c);
  const spot = (key, label, icon) => {
    const p = c[key];
    return `<div class="spot ${p ? 'set' : ''}">
      <span class="spot-ic">${ic(icon, true)}</span>
      <div class="spot-t"><b>${label}</b><small>${p ? 'gemerkt' : 'noch nicht gesetzt'}</small></div>
      <div class="spot-a">
        ${p ? `<button type="button" class="ic" ${navPt(p, c.street)} aria-label="Hinfahren">${ic('navigation-arrow')}</button>` : ''}
        <button type="button" class="ic" data-pick="${key}" aria-label="Auf Karte setzen">${ic('map-trifold')}</button>
        <button type="button" class="ic" data-gps="${key}" aria-label="Hier per GPS">${ic('crosshair')}</button>
        ${p ? `<button type="button" class="ic del" data-clear="${key}" aria-label="Löschen">${ic('x')}</button>` : ''}
      </div></div>`;
  };
  const d = openDialog(`
    <div class="cd-head">
      <span class="av">${esc(initials(c))}</span>
      <div class="cd-title"><b>${esc(c.name || c.street)}</b><small>${c.name ? esc(c.street) + ' · ' : ''}${esc(c.plz)} ${esc(c.ort)}</small></div>
      ${c.phone ? `<a class="ic big dark" href="tel:${esc(c.phone)}" aria-label="Anrufen">${ic('phone', true)}</a>` : ''}
    </div>
    <div class="cd-stats">
      <span><b>${st.n}×</b> beliefert</span><span><b>${fr(st.avgTip)}</b> Ø Trinkgeld</span><span><b>${st.last ? dt(st.last) : '–'}</b> zuletzt</span>
    </div>
    <h2>Hinweise</h2>
    <div class="tagtiles">${TAGS.map(t => `<button type="button" class="tt ${c.tags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">${ic(TAG_ICON[t] || 'tag')}<span>${esc(t.replace(' – anrufen', ''))}</span></button>`).join('')}</div>
    <h2>Notiz</h2>
    <textarea id="cNotes" placeholder="z. B. 2. Stock links · Code 1234">${esc(c.notes)}</textarea>
    <h2>Telefon</h2>
    <input id="cPhone" type="tel" inputmode="tel" value="${esc(c.phone)}" placeholder="079 123 45 67">
    <h2>Orte</h2>
    ${spot('park', 'Parkplatz', 'car-profile')}
    ${spot('bell', 'Klingel / Eingang', 'door')}
    <button type="button" class="linkbtn" data-pick="house">${ic('map-pin-area')} Hauspunkt auf Karte korrigieren</button>
    ${st.n ? `<details class="acc"><summary>Verlauf · ${st.n}</summary><table class="t">${c.visits.slice(-10).reverse().map(v => `<tr><td>${dt(v.t)}</td><td class="r">CHF ${fr(v.amount)}</td><td class="r">+${fr(v.tip)}</td></tr>`).join('')}</table></details>` : ''}
    <div class="foot sticky">
      <button class="btn" value="cancel" type="submit">Zurück</button>
      <button class="btn primary" id="cSave" type="button">${ic('check')} Speichern</button>
    </div>
    <button class="linkbtn danger" id="cDel" type="button">${ic('trash')} Kunde löschen</button>`);
  const keep = () => { c.notes = $('#cNotes', d).value.trim(); c.phone = $('#cPhone', d).value.replace(/\s/g, ''); };
  $$('[data-tag]', d).forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tag; c.tags = c.tags.includes(t) ? c.tags.filter(x => x !== t) : [...c.tags, t]; b.classList.toggle('on'); navigator.vibrate?.(10);
  }));
  $$('[data-pick]', d).forEach(b => b.addEventListener('click', () => { keep(); save(); closeDialog(); startPick(b.dataset.pick, c.id); }));
  $$('[data-gps]', d).forEach(b => b.addEventListener('click', async () => {
    try { const p = lastPos && Date.now() - (lastPos.t || 0) < 30000 ? lastPos : await gps(); c[b.dataset.gps] = { lat: p.lat, lng: p.lng }; keep(); save(); toast(`Gespeichert · ±${Math.round(p.acc || 0)} m`); customerDialog(c.id); }
    catch (e) { toast('GPS nicht verfügbar'); }
  }));
  $$('[data-clear]', d).forEach(b => b.addEventListener('click', () => { c[b.dataset.clear] = null; keep(); save(); customerDialog(c.id); }));
  $('#cSave', d).addEventListener('click', () => { keep(); save(); closeDialog(); refreshAll(); toast('Gespeichert'); });
  $('#cDel', d).addEventListener('click', () => {
    if (!confirm('Kunde mit allen Notizen löschen?')) return;
    delete db.customers[c.id]; db.tour = db.tour.filter(o => o.custId !== c.id); save(); closeDialog(); refreshAll();
  });
}

// ---------- Kundenliste (neu) ----------
function renderKunden(q = '') {
  const v = $('#view-kunden');
  const list = Object.values(db.customers)
    .filter(c => !q || norm(addrLine(c) + ' ' + (c.name || '') + ' ' + c.notes + ' ' + c.phone).includes(norm(q)))
    .sort((a, b) => (custStats(b).last || b.created) - (custStats(a).last || a.created));
  if (!$('#kq', v)) {
    v.innerHTML = `<div class="vh-row"><h1 class="vh">Kunden</h1><button class="ic big" type="button" data-back aria-label="Zurück">${ic('x')}</button></div>
      <div class="searchbox">${ic('magnifying-glass')}<input id="kq" type="search" placeholder="Name, Strasse, Ort, Notiz"></div>
      <div id="klist" class="clist"></div>`;
    $('#kq', v).addEventListener('input', e => renderKunden(e.target.value));
    $('[data-back]', v).addEventListener('click', () => showView('einst'));
  }
  $('#klist', v).innerHTML = list.length ? list.map(c => {
    const st = custStats(c);
    return `<button class="crow" data-cust-open="${esc(c.id)}" type="button">
      <span class="av sm">${esc(initials(c))}</span>
      <span class="crow-b"><b>${esc(c.name || c.street)}</b><small>${c.name ? esc(c.street) + ' · ' : ''}${esc(c.ort)}</small>
        ${(c.tags || []).length ? `<span class="crow-tags">${c.tags.slice(0, 4).map(t => ic(TAG_ICON[t] || 'tag')).join('')}</span>` : ''}</span>
      <span class="crow-n"><b>${st.n}×</b><small>${fr(st.avgTip)}</small></span>
    </button>`;
  }).join('') : '<div class="empty">Noch keine Kunden. Sie entstehen automatisch beim Scannen.</div>';
}
$('#view-kunden').addEventListener('click', e => { const b = e.target.closest('[data-cust-open]'); if (b) customerDialog(b.dataset.custOpen); });

// =====================================================================
//  v10 – NEUE OBERFLÄCHE: Karte (search.ch) · GPS-Tracker · Kamera · Liste
// =====================================================================
let current = 'karte';
let lastPos = null;                       // letzte GPS-Position {lat,lng,acc,heading,speed,t}
let smap = null, map = null;              // search.ch-Karte (map = für ältere Aufrufe)
let mePoi = null, basePoi = null, stopPois = [], searchPin = null, lastSearchPoint = null, pick = null;
const live = { on: true, target: null, at: 0 };  // target: {orderId} | {p,label,h}
const route = { to: null, from: null, at: 0, min: null, km: null, txt: '' };
let follow = false;

// ---------- Kompatibilität mit den übernommenen Teilen ----------
function renderTour() { renderAll(); }
function drawMap() { renderMapPois(); }
function refreshAll() { renderAll(); }
function liveTick() { updateRoute(true); }
function closeDialogIfOpen() { const d = $('#dlg'); if (d && d.open) d.close(); }
const navPt = (p, label) => `data-navpt="${p.lat},${p.lng},${esc(label || '')}"`;
document.addEventListener('click', e => {
  const n = e.target.closest('[data-nav]');
  if (n) { e.preventDefault(); closeDialogIfOpen(); goTo(n.dataset.nav); return; }
  const np = e.target.closest('[data-navpt]');
  if (np) { e.preventDefault(); closeDialogIfOpen(); const [lat, lng, ...l] = np.dataset.navpt.split(','); live.target = { p: { lat: +lat, lng: +lng }, label: l.join(',') }; showView('karte'); updateRoute(true); renderCard(); }
});
function goTo(orderId) { live.target = orderId ? { orderId } : null; showView('karte'); updateRoute(true); renderAll(); }
function afterDelivered() {
  live.target = null;
  const nx = openStops()[0];
  if (nx) toast(`➡️ Weiter: ${db.customers[nx.custId]?.street || ''}`, 2200);
  else toast('Alle geliefert 🎉 Route zurück zu Subito', 2600);
  updateRoute(true); renderAll();
}

// ---------- Kleine Helfer ----------
const payLabel = p => ({ bar: 'Bar', karte: 'Karte', online: 'Online bezahlt' }[p] || p);
const svgUri = s => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
function pinIcon(txt, bg, fg = '#14210F', ring = '#14210F') {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" fill="${bg}" stroke="${ring}" stroke-width="3"/><text x="18" y="23.5" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="15" fill="${fg}">${txt}</text></svg>`);
}
const ME_ICON = svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#1e88e5" fill-opacity=".18"/><circle cx="22" cy="22" r="9" fill="#1e88e5" stroke="#fff" stroke-width="4"/></svg>');
const BASE_ICON = svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 38 38"><circle cx="19" cy="19" r="17" fill="#14210F" stroke="#8DDD58" stroke-width="3"/><path d="M19 9 11 26h16z" fill="#F6C343"/><circle cx="17" cy="19" r="2" fill="#E30613"/><circle cx="21" cy="23" r="2" fill="#E30613"/></svg>');
const SEARCH_ICON = pinIcon('+', '#14210F', '#8DDD58', '#8DDD58');
function parseMin(t) { // "4 min", "1 h 5 min", "1 Std. 5 Min."
  if (!t) return null; const s = String(t).toLowerCase();
  const h = +(s.match(/(\d+)\s*(h|std)/) || [0, 0])[1], m = +(s.match(/(\d+)\s*min/) || [0, 0])[1];
  return h * 60 + m || null;
}
const isArrived = (o, c) => { const d = c && (doorPoint(c) || target(c)); return !!(lastPos && d && hav(lastPos, d) < 0.07); };

// =====================================================================
//  GPS-TRACKER – läuft immer, solange die App offen ist
// =====================================================================
const gpsState = { status: 'off', watch: null };
function startGps() {
  if (!navigator.geolocation) { gpsState.status = 'none'; renderGpsPill(); return; }
  if (gpsState.watch != null) return;
  if (gpsState.status !== 'ok') gpsState.status = 'search';
  renderGpsPill();
  gpsState.watch = navigator.geolocation.watchPosition(onGps, err => {
    gpsState.status = err.code === 1 ? 'denied' : 'error';
    if (err.code === 1 && gpsState.watch != null) { navigator.geolocation.clearWatch(gpsState.watch); gpsState.watch = null; }
    renderGpsPill();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 25000 });
}
function stopGps() { if (gpsState.watch != null) { navigator.geolocation.clearWatch(gpsState.watch); gpsState.watch = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') startGps();
  else { stopGps(); if (typeof cam !== 'undefined' && cam.stream) closeCamera(); }
});

function onGps(p) {
  const pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, t: Date.now() };
  const first = !lastPos;
  lastPos = pos; gpsState.status = 'ok'; renderGpsPill();
  showMe(pos);
  if (follow && smap) smap.go({ center: [pos.lat, pos.lng] });
  if (pos.acc <= 80) detectArrival(pos);
  updateRoute(first);
  renderCard();
}
// Ankunft erkennen (unter 70 m) + Fahrzeit lernen
function detectArrival(pos) {
  let changed = false;
  openStops().forEach(o => {
    if (o.arrivedAt) return;
    const c = db.customers[o.custId]; const door = doorPoint(c) || target(c); if (!door) return;
    if (hav(pos, door) < 0.07) {
      o.arrivedAt = Date.now(); o.arrivePos = { lat: pos.lat, lng: pos.lng }; changed = true;
      if (lastRoute?.seq) {
        const k = lastRoute.seq.indexOf(o.id);
        const prev = k > 0 ? db.tour.find(x => x.id === lastRoute.seq[k - 1]) : null;
        const from = prev ? prev.doneAt : (k === 0 ? lastRoute.departAt : null);
        if (from && k >= 0 && lastRoute.legs?.[k]) learnDrive((o.arrivedAt - from) / 1000, lastRoute.legs[k]);
      }
      const tg = currentTarget();
      if (tg && tg.o && tg.o.id === o.id) { navigator.vibrate?.([60, 40, 60]); toast(`📍 Angekommen: ${c.street}`, 2500); }
    }
  });
  if (changed) save();
}
function renderGpsPill() {
  const b = $('#gpsPill'); if (!b) return;
  const s = gpsState.status;
  b.className = 'gps ' + s + (follow && s === 'ok' ? ' follow' : '');
  $('.g-txt', b).textContent = s === 'ok' ? `±${Math.round(lastPos?.acc || 0)} m` : s === 'search' ? 'sucht…' : s === 'denied' ? 'GPS aus' : s === 'none' ? 'kein GPS' : 'GPS ?';
}
$('#gpsPill').addEventListener('click', () => {
  const s = gpsState.status;
  if (s === 'ok') { follow = !follow; renderGpsPill(); if (follow && smap && lastPos) smap.go({ center: [lastPos.lat, lastPos.lng], zoomlevel: 18 }); if (!follow) updateRoute(true); toast(follow ? '◎ Karte folgt dir' : 'Folgen aus'); return; }
  openDialog(`
    <h3>Standort (GPS)</h3>
    <p>${s === 'denied' ? 'Dein Handy blockiert den Standort für diese App.' : 'Die App sucht deinen Standort.'}</p>
    <p class="hint"><b>iPhone:</b> Einstellungen → Datenschutz &amp; Sicherheit → Ortungsdienste → <b>Safari-Websites</b> → „Beim Verwenden der App“ und <b>Genauer Standort</b> an.<br>
    Dann die App ganz schliessen und neu öffnen.</p>
    <p class="hint"><b>Android:</b> Chrome → ⋮ → Einstellungen → Websiteeinstellungen → Standort → erlauben.</p>
    <div class="foot"><button class="btn" value="cancel" type="submit">OK</button><button class="btn primary" type="button" id="gpsRetry">Nochmal versuchen</button></div>`);
  $('#gpsRetry').onclick = () => { closeDialog(); stopGps(); gpsState.status = 'search'; renderGpsPill(); startGps(); };
});

// =====================================================================
//  KARTE – search.ch, Route automatisch vom Standort zur nächsten Lieferung
// =====================================================================
function initMap() {
  if (smap || typeof SearchChMap === 'undefined') return;
  const b = db.settings.base;
  smap = map = new SearchChMap({
    container: 'map', center: lastPos ? [lastPos.lat, lastPos.lng] : b ? [b.lat, b.lng] : 'Landquart',
    zoomlevel: 16, type: 'aerial', controls: '', marker: false, gestureHandling: 'greedy'
  });
  smap.addEventListener('dragstart', () => { if (follow) { follow = false; renderGpsPill(); } });
  smap.addEventListener('change', () => readRouteInfo());
  smap.addEventListener('mouseclick', onMapClick);
  // Nur echtes Luftbild
  const aerial = () => { try { if (smap.get('type') !== 'aerial') smap.set({ type: 'aerial' }); } catch (e) { /* egal */ } };
  aerial(); setTimeout(aerial, 800); smap.addEventListener('load', aerial);
  renderMapPois();
  if (lastPos) showMe(lastPos);
  updateRoute(true);
}
function resetMap() {
  if (!smap) return;
  smap = map = null; mePoi = null; basePoi = null; stopPois = []; searchPin = null;
  const el = $('#map'); const fresh = el.cloneNode(false); el.replaceWith(fresh);
  route.to = null;
  initMap();
}
function showMe(p) {
  if (!smap) return;
  if (!mePoi) { mePoi = new SearchChPOI({ center: [p.lat, p.lng], title: 'Ich', icon: ME_ICON, width: 44, height: 44 }); smap.addPOI(mePoi); }
  else mePoi.set({ center: [p.lat, p.lng] });
}
// search.ch-Punkt wirklich entfernen (removePOI allein lässt ihn sichtbar)
function killPoi(x) { if (!x) return; try { x.hide(); } catch (e) { /* egal */ } try { x.destroy(); } catch (e) { /* egal */ } try { smap.removePOI(x); } catch (e) { /* egal */ } }
function renderMapPois() {
  if (!smap) return;
  stopPois.forEach(killPoi); stopPois = [];
  const b = db.settings.base;
  if (basePoi && (!b || basePoi._lat !== b.lat || basePoi._lng !== b.lng)) { killPoi(basePoi); basePoi = null; }
  if (b && !basePoi) { basePoi = new SearchChPOI({ center: [b.lat, b.lng], title: 'Subito', html: `<b>${SUBITO.name}</b><br>${SUBITO.street}, ${SUBITO.plz} ${SUBITO.ort}`, icon: BASE_ICON, width: 38, height: 38 }); basePoi._lat = b.lat; basePoi._lng = b.lng; smap.addPOI(basePoi); }
  const tg = currentTarget();
  openStops().forEach((o, i) => {
    const c = db.customers[o.custId]; if (!c) return;
    const isT = tg && tg.o && tg.o.id === o.id, late = lateBy(o) > 0;
    const center = c.lat != null ? [c.lat, c.lng] : `${c.plz} ${c.ort}, ${c.street}`;
    const poi = new SearchChPOI({
      center, title: `${i + 1}`, icon: pinIcon(i + 1, late ? '#E30613' : isT ? '#8DDD58' : '#ffffff', late ? '#fff' : '#14210F'), width: 36, height: 36,
      html: `<b>${esc(c.street)}</b><br>${esc(c.plz)} ${esc(c.ort)}${o.time ? ` · 🕗 ${esc(o.time)}` : ''}<br><button class="btn sm primary" type="button" data-nav="${o.id}">Hinfahren</button>`
    });
    smap.addPOI(poi); stopPois.push(poi);
    if (c.park) { const pp = new SearchChPOI({ center: [c.park.lat, c.park.lng], title: 'P', icon: pinIcon('P', '#1565c0', '#fff', '#fff'), width: 28, height: 28, html: `🅿️ Parkplatz ${esc(c.street)}` }); smap.addPOI(pp); stopPois.push(pp); }
  });
}
// Wohin geht's gerade?
function currentTarget() {
  const t = live.target;
  if (t && t.p) return { kind: 'point', p: t.p, label: t.label, h: t.h };
  const open = openStops();
  let o = t && t.orderId ? open.find(x => x.id === t.orderId) : null;
  if (!o) { if (t && t.orderId) live.target = null; o = open[0]; }
  if (o) { const c = db.customers[o.custId]; return { kind: 'order', o, c, p: target(c) }; }
  if (doneStops().length && db.settings.base) return { kind: 'home', p: db.settings.base, label: 'Subito' };
  return null;
}
function routeTarget(tg) {
  if (tg.kind === 'order') { const c = tg.c; if (c.park) return `${c.park.lat},${c.park.lng}`; return `${c.plz} ${c.ort}, ${c.street}`; }
  return `${tg.p.lat},${tg.p.lng}`;
}
function updateRoute(force) {
  if (!smap) return;
  const tg = currentTarget();
  if (!tg) {
    // search.ch kann eine Route nicht löschen → Karte ohne Route neu aufbauen
    if (route.to) resetMap();
    route.to = null; route.min = null; route.km = null; route.txt = ''; return;
  }
  const fromP = lastPos || db.settings.base; if (!fromP) return;
  const to = routeTarget(tg);
  const moved = route.from ? hav(route.from, fromP) * 1000 : 1e9;
  if (!force && route.to === to && moved < 250 && Date.now() - route.at < 90000) return;
  // Alte Routeninfo nur ignorieren, wenn sich das Ziel geändert hat
  try { const old = smap.get('routeinfo'); route.stale = old && old.time && route.to && route.to !== to ? `${old.time}|${old.distance}` : null; } catch (e) { route.stale = null; }
  route.to = to; route.from = fromP; route.at = Date.now(); route.min = null; route.km = null; route.txt = '';
  try { smap.set({ from: `${fromP.lat.toFixed(5)},${fromP.lng.toFixed(5)}`, to, routemode: 'car' }); } catch (e) { /* später */ }
  setTimeout(readRouteInfo, 1500); setTimeout(readRouteInfo, 4000); setTimeout(readRouteInfo, 6000);
  renderCard();
}
function readRouteInfo() {
  try {
    const ri = smap && smap.get('routeinfo');
    if (ri && ri.time) {
      // Info der vorherigen Route ignorieren, solange die neue noch rechnet
      if (route.stale && `${ri.time}|${ri.distance}` === route.stale && Date.now() - route.at < 5000) return;
      const m = parseMin(ri.time);
      if (m !== route.min || ri.distance !== route.km) { route.min = m; route.km = ri.distance; route.txt = `${ri.time} · ${ri.distance}`; updateEtaFromRoute(); renderCard(); }
    }
  } catch (e) { /* noch nicht da */ }
}
// Ankunftszeit für den aktuellen Stopp aus der search.ch-Route (+ gelerntes Tempo)
function updateEtaFromRoute() {
  const tg = currentTarget(); if (!tg || tg.kind !== 'order' || route.min == null) return;
  if (!lastRoute) setRoute({ geo: null, dur: 0, dist: 0, legs: [], seq: [], departAt: Date.now(), eta: {} });
  lastRoute.eta = lastRoute.eta || {};
  const f = driveFactor(); let t = Date.now() + route.min * 60000 * f;
  lastRoute.eta[tg.o.id] = t; t += svcMin(tg.c) * 60000;
  // die weiteren Stopps verschieben sich mit
  const rest = openStops().filter(o => o.id !== tg.o.id);
  rest.forEach((o, k) => { const old = lastRoute.eta[o.id]; if (old && k === 0) { /* Abstand grob beibehalten */ } });
  save();
}
function onMapClick(e) {
  $('#mapResults').hidden = true;
  if (!pick) return;
  let lat = e.lat, lng = e.lon;
  if ((lat == null || lng == null) && e.mx != null) { const w = lv03ToWgs(e.mx, e.my); lat = w.lat; lng = w.lng; }
  if (lat == null) return;
  const c = db.customers[pick.custId]; if (!c) return endPick();
  const p = { lat, lng };
  if (pick.kind === 'house') { c.lat = lat; c.lng = lng; c.approx = false; } else c[pick.kind] = p;
  save(); const id = c.id; endPick(); renderAll(); toast('Punkt gespeichert ✓');
  setTimeout(() => customerDialog(id), 400);
}
// Schweizer Landeskoordinaten (LV03) → GPS (Näherung von swisstopo)
function lv03ToWgs(y, x) {
  const yy = (y - 600000) / 1e6, xx = (x - 200000) / 1e6;
  const lng = (2.6779094 + 4.728982 * yy + 0.791484 * yy * xx + 0.1306 * yy * xx * xx - 0.0436 * yy * yy * yy) * 100 / 36;
  const lat = (16.9023892 + 3.238272 * xx - 0.270978 * yy * yy - 0.002528 * xx * xx - 0.0447 * yy * yy * xx - 0.014 * xx * xx * xx) * 100 / 36;
  return { lat, lng };
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
  if (p && smap) smap.go({ center: [p.lat, p.lng], zoomlevel: 19 });
}
function endPick() { pick = null; $('#pickbar').hidden = true; }


// ---------- Die grosse Karte unten: aktueller Kunde ----------
function renderCard() {
  const el = $('#card'); if (!el) return;
  const html = cardHtml();
  if (html !== el._h) { el.innerHTML = html; el._h = html; }
}
function cardHtml() {
  const tg = currentTarget();
  const open = openStops();
  if (!tg) {
    return `<div class="cs empty"><b>Keine Lieferungen</b><small>Zettel fotografieren – die Route kommt automatisch.</small>
      <div class="cs-btns"><button class="btn primary big" type="button" data-act="cam">📷 Zettel scannen</button><button class="btn" type="button" data-act="add">＋</button></div></div>`;
  }
  if (tg.kind === 'home') {
    return `<div class="cs"><div class="cs-head"><span class="cs-num home">🍕</span><div class="cs-title"><b>Zurück zu Subito</b><small>Alle Lieferungen erledigt 🎉</small></div></div>
      <div class="cs-route">${route.txt ? '🚗 ' + esc(route.txt) : ''}</div>
      <div class="cs-btns"><button class="btn primary big" type="button" data-act="cam">📷 Neue Tour</button><button class="btn" type="button" data-act="cleardone">Liste leeren</button></div></div>`;
  }
  if (tg.kind === 'point') {
    const h = tg.h || {};
    return `<div class="cs"><div class="cs-head"><span class="cs-num pt">＋</span><div class="cs-title"><b>${esc(tg.label || 'Ziel')}</b><small>${esc([h.plz, h.ort].filter(Boolean).join(' '))}</small></div>
      <button class="cs-x" type="button" data-act="cleartarget" aria-label="Schliessen">✕</button></div>
      <div class="cs-route">${route.txt ? '🚗 ' + esc(route.txt) : 'Route wird berechnet…'}</div>
      <div class="cs-btns">${h.street ? '<button class="btn primary big" type="button" data-act="addpoint">＋ Zur Tour</button>' : ''}<button class="btn" type="button" data-act="cleartarget">Fertig</button></div></div>`;
  }
  const { o, c } = tg, i = open.indexOf(o);
  const arrived = isArrived(o, c), late = lateBy(o), eta = lastRoute?.eta?.[o.id];
  const cash = o.pay === 'bar' && +o.amount > 0;
  const [rMin, rKm] = (route.txt || '').split(' · ');
  return `<div class="cs ${arrived ? 'arrived' : ''} ${late > 0 ? 'late' : ''}">
    <div class="cs-top">
      <div class="cs-eta">${arrived ? `${ic('map-pin', true)}<b>Angekommen</b>` : route.txt ? `${ic('car-profile', true)}<b>${esc(rMin)}</b><span>${esc(rKm || '')}</span>` : `<span class="spin"></span><span>Route…</span>`}</div>
      ${late > 0 ? `<span class="tag-late">${ic('clock', true)} ${late}′ spät</span>` : eta ? `<span class="tag-time">an ${tm(eta)}</span>` : ''}
      ${open.length > 1 ? `<div class="cs-pager"><button type="button" data-act="prev" aria-label="Vorheriger">${ic('caret-left')}</button><span>${i + 1}/${open.length}</span><button type="button" data-act="next" aria-label="Nächster">${ic('caret-right')}</button></div>` : ''}
    </div>
    <div class="cs-addr">
      <span class="cs-num">${i + 1}</span>
      <div class="cs-title"><b>${esc(c.street)}</b><small>${esc(c.plz)} ${esc(c.ort)}${o.time ? ` · <b class="due">bis ${esc(o.time)}</b>` : ''}${c.name ? ' · ' + esc(c.name) : ''}</small></div>
    </div>
    ${itemsHtml(o.items)}
    <div class="cs-info">
      <span class="pill ${cash ? 'cash' : ''}">${cash ? `${ic('money', true)} ${fr(o.amount)} kassieren` : `${ic(o.pay === 'karte' ? 'credit-card' : 'check-circle', true)} ${o.pay === 'online' ? 'Bezahlt' : payLabel(o.pay)} · ${fr(o.amount)}`}</span>
      ${(c.tags || []).map(t => `<span class="pill warn" title="${esc(t)}">${ic(TAG_ICON[t] || 'warning')}${arrived ? ' ' + esc(t.replace(' – anrufen', '')) : ''}</span>`).join('')}
      ${arrived && o.note ? `<span class="pill">${ic('note-pencil')} ${esc(o.note)}</span>` : ''}
    </div>
    ${arrived && c.notes ? `<div class="cs-note">${ic('note-pencil')} ${esc(c.notes)}</div>` : ''}
    <div class="cs-btns">
      ${c.phone ? `<a class="btn call" href="tel:${esc(c.phone)}" aria-label="Anrufen">${ic('phone', true)}${late > 0 ? ' Bescheid' : ''}</a>` : ''}
      <button class="btn primary big ${arrived ? 'pulse' : ''}" type="button" data-done="${o.id}">${ic('check-circle', true)} Geliefert</button>
      <button class="btn more" type="button" data-cust="${esc(c.id)}" aria-label="Kunde">${ic('dots-three')}</button>
    </div>
  </div>`;
}
$('#card').addEventListener('click', e => {
  const d = e.target.closest('[data-done]'); if (d) { deliveredDialog(d.dataset.done); return; }
  const cu = e.target.closest('[data-cust]'); if (cu) { customerDialog(cu.dataset.cust); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const open = openStops(), tg = currentTarget();
  const i = tg && tg.o ? open.indexOf(tg.o) : 0;
  ({
    cam: () => openCamera(),
    add: () => orderDialog(),
    next: () => { live.target = { orderId: open[(i + 1) % open.length].id }; updateRoute(true); renderAll(); },
    prev: () => { live.target = { orderId: open[(i - 1 + open.length) % open.length].id }; updateRoute(true); renderAll(); },
    cleartarget: () => { live.target = null; killPoi(searchPin); searchPin = null; updateRoute(true); renderAll(); },
    addpoint: () => { const h = tg.h; lastSearchPoint = h; orderDialog({ street: h.street, plz: h.plz, ort: h.ort }); },
    cleardone: () => { db.tour = openStops(); setRoute(null); save(); renderAll(); }
  })[b.dataset.act]?.();
});

// ---------- Adresssuche mit Vorschlägen (Kunden ⭐ zuerst, dann Photon) ----------
let searchHits = [], suggestTimer = null, suggestCtl = null;
function renderHits(loading) {
  const box = $('#mapResults');
  if (!searchHits.length && !loading) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = searchHits.map((h, i) => `<button class="res" type="button" data-i="${i}">
      <span class="res-ic">${h.kind === 'cust' ? '⭐' : h.kind === 'street' ? '🛣️' : h.kind === 'poi' ? '📍' : '🏠'}</span>
      <span><b>${esc(h.title)}</b><small>${esc(h.sub)}</small></span></button>`).join('')
    + (loading ? '<div class="res"><span class="spin"></span> Suche…</div>' : '');
}
function suggest(q) {
  q = q.trim(); clearTimeout(suggestTimer);
  const nq = norm(q);
  const custs = Object.values(db.customers)
    .filter(c => !nq || norm(`${c.street} ${c.plz} ${c.ort} ${c.name || ''}`).includes(nq))
    .sort((a, b) => (custStats(b).last || 0) - (custStats(a).last || 0)).slice(0, nq ? 4 : 5)
    .map(c => ({ kind: 'cust', lat: c.lat, lng: c.lng, street: c.street, plz: c.plz, ort: c.ort, title: c.street, sub: `${c.plz} ${c.ort}${c.name ? ' · ' + c.name : ''} · ${custStats(c).n}×` }));
  searchHits = custs;
  if (q.length < 3) { renderHits(false); return; }
  renderHits(true);
  suggestTimer = setTimeout(async () => {
    try {
      if (suggestCtl) suggestCtl.abort();
      suggestCtl = new AbortController();
      const b = lastPos || db.settings.base || { lat: 46.96, lng: 9.56 };
      const r = await fetch(`https://photon.komoot.io/api/?q=${enc(q)}&limit=8&lang=de&lat=${b.lat}&lon=${b.lng}&bbox=9.2,46.75,9.95,47.15`, { signal: suggestCtl.signal });
      const j = await r.json();
      const seen = new Set(custs.map(h => norm(h.street + h.plz))), more = [];
      for (const f of j.features || []) {
        const p = f.properties || {}; if (p.countrycode !== 'CH') continue;
        const isStreet = p.osm_key === 'highway' && !p.housenumber;
        const street = p.housenumber ? `${p.street || p.name} ${p.housenumber}` : (isStreet ? p.name : (p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : p.name));
        const plz = p.postcode || '', ort = PLZ_ORT[plz] || p.city || p.district || '';
        const key = norm(street + plz); if (!street || seen.has(key)) continue; seen.add(key);
        const kind = p.housenumber ? 'addr' : isStreet ? 'street' : 'poi';
        more.push({ kind, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], street: kind === 'poi' && p.street ? p.street + (p.housenumber ? ' ' + p.housenumber : '') : street,
          plz, ort, title: kind === 'poi' ? p.name : street, sub: [kind === 'poi' && p.street ? p.street : '', [plz, ort].filter(Boolean).join(' ')].filter(Boolean).join(' · ') });
      }
      if ($('#mapQ').value.trim() !== q) return;
      searchHits = [...custs, ...more].slice(0, 8); renderHits(false);
    } catch (e) { if (e.name !== 'AbortError') renderHits(false); }
  }, 220);
}
function pickHit(h) {
  if (!h) return;
  if (h.kind === 'street') {
    const inp = $('#mapQ'); inp.value = `${h.street} `; inp.focus(); suggest(inp.value);
    if (smap) smap.go({ center: [h.lat, h.lng], zoomlevel: 17 }); toast('Hausnummer dazutippen', 1600); return;
  }
  $('#mapResults').hidden = true; $('#mapQ').blur(); $('#mapQ').value = '';
  // bekannter Kunde mit offener Bestellung → direkt dorthin
  const known = findCustomer(h.street, h.ort);
  const ord = known && openStops().find(o => o.custId === known.id);
  if (ord) { goTo(ord.id); return; }
  if (!smap) { toast('Karte noch nicht geladen (Internet?)'); return; }
  const lat = h.lat ?? known?.lat, lng = h.lng ?? known?.lng;
  if (lat == null) { toast('Kein Punkt für diese Adresse'); return; }
  killPoi(searchPin);
  searchPin = new SearchChPOI({ center: [lat, lng], title: h.street, icon: SEARCH_ICON, width: 36, height: 36 });
  smap.addPOI(searchPin);
  live.target = { p: { lat, lng }, label: h.street || h.title, h: { ...h, lat, lng } };
  follow = false; renderGpsPill();
  updateRoute(true); renderCard();
}
$('#mapSearch').addEventListener('submit', e => { e.preventDefault(); if (searchHits.length) pickHit(searchHits[0]); });
$('#mapQ').addEventListener('input', e => suggest(e.target.value));
$('#mapQ').addEventListener('focus', e => suggest(e.target.value));
$('#mapResults').addEventListener('click', e => { const r = e.target.closest('[data-i]'); if (r) pickHit(searchHits[+r.dataset.i]); });

// =====================================================================
//  KAMERA in der App: antippen = Foto. Gelesen wird im Hintergrund.
// =====================================================================
const cam = { stream: null, queue: [], busy: false, added: 0, track: null, torch: false };
async function openCamera() {
  if (cam.stream || cam.opening) return;
  const box = $('#cam');
  if (!cam.busy) { $('#camThumbs').innerHTML = ''; cam.added = 0; }
  if (!navigator.mediaDevices?.getUserMedia) { $('#camFallback').click(); return; }
  cam.opening = true;
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (e) {
    cam.opening = false;
    // Kamera nicht erlaubt → eigener Tipp öffnet die normale Foto-Auswahl
    openDialog(`<h3>Kamera nicht freigegeben</h3><p class="hint">Erlaube die Kamera für Safari/Chrome in den Einstellungen – oder fotografiere so:</p>
      <div class="bigbtns"><label class="btn primary" for="camFallback">📷 Foto machen</label><button class="btn" value="cancel" type="submit">Abbrechen</button></div>`);
    return;
  }
  cam.opening = false;
  const v = $('#camVideo'); v.srcObject = cam.stream; await v.play().catch(() => {});
  cam.track = cam.stream.getVideoTracks()[0];
  cam.track.onended = () => { if (cam.stream) closeCamera(); };
  try { const caps = cam.track.getCapabilities?.() || {}; $('#camTorch').hidden = !caps.torch; } catch (e) { $('#camTorch').hidden = true; }
  box.hidden = false; document.body.classList.add('cam-open');
  $('#camHint').textContent = 'Zettel ins Feld halten · Auslöser drücken';
  // Texterkennung schon mal starten
  warmOcr();
}
function closeCamera() {
  if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  cam.stream = null; cam.torch = false;
  $('#cam').hidden = true; document.body.classList.remove('cam-open');
  showView('karte');
  // Route sofort, falls schon alles gelesen ist – sonst macht es die Warteschlange am Schluss
  if (cam.added && !cam.busy && !cam.queue.length) routeAfterScan();
  renderAll();
}
function shoot() {
  const v = $('#camVideo'); if (!v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const f = $('#camFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  navigator.vibrate?.(25);
  enqueue(c);
}
function enqueue(img) {
  const th = document.createElement('div'); th.className = 'thumb wait';
  try {
    const t = document.createElement('canvas'); const s = 120 / Math.max(img.width || 1, img.height || 1);
    if (img.width) { t.width = img.width * s; t.height = img.height * s; t.getContext('2d').drawImage(img, 0, 0, t.width, t.height); th.style.backgroundImage = `url(${t.toDataURL('image/jpeg', .6)})`; }
  } catch (e) { /* ohne Vorschau */ }
  th.innerHTML = '<span class="spin"></span>';
  $('#camThumbs').prepend(th);
  cam.queue.push({ img, th });
  processQueue();
}
function routeAfterScan() { autoRoute(200).then(() => { live.target = null; updateRoute(true); renderAll(); }); }
async function processQueue() {
  if (cam.busy) return; cam.busy = true;
  let addedRun = 0;
  while (cam.queue.length) {
    const { img, th } = cam.queue.shift();
    try {
      const p = parseOrder(await ocr(img, () => {}));
      if (!p.street) { th.className = 'thumb bad'; th.innerHTML = '<b>?</b>'; th.title = 'Adresse nicht erkannt – antippen'; th.onclick = () => { closeCamera(); orderDialog(p); }; }
      else if (isDuplicate(p)) { th.className = 'thumb dup'; th.innerHTML = '<b>2×</b>'; }
      else {
        const { c } = await addOrderFromParsed(p);
        cam.added++; addedRun++; th.className = 'thumb ok'; th.innerHTML = `<b>✓</b><small>${esc(c.street)}</small>`;
        $('#camDone').textContent = `Fertig · ${openStops().length}`;
        renderBadge();
      }
    } catch (e) { th.className = 'thumb bad'; th.innerHTML = '<b>!</b>'; th.onclick = () => { toast('Foto nicht lesbar – nochmal fotografieren oder von Hand'); }; }
  }
  cam.busy = false;
  // Kamera schon zu? Dann jetzt Route & Karte aktualisieren
  if (addedRun && $('#cam').hidden) routeAfterScan();
  else renderAll();
}
// Bilddatei (aus Galerie/Fallback) → Bild-Objekt für die Texterkennung
async function fileToImg(file) { try { return await createImageBitmap(file); } catch (e) { return file; } }
$('#camShot').addEventListener('click', shoot);
$('#camVideo').addEventListener('click', shoot);
$('#camClose').addEventListener('click', closeCamera);
$('#camDone').addEventListener('click', closeCamera);
$('#camTorch').addEventListener('click', async () => {
  cam.torch = !cam.torch;
  try { await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }); $('#camTorch').classList.toggle('on', cam.torch); } catch (e) { toast('Licht nicht möglich'); }
});
$('#camLib').addEventListener('change', async e => { for (const f of [...e.target.files]) enqueue(await fileToImg(f)); e.target.value = ''; });
$('#camFallback').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  closeDialogIfOpen();
  $('#cam').hidden = false; document.body.classList.add('cam-open'); $('#camThumbs').innerHTML = '';
  $('#camHint').textContent = 'Kamera ohne Freigabe – Fotos werden gelesen';
  for (const f of files) enqueue(await fileToImg(f));
});
$('#btnCam').addEventListener('click', openCamera);
function warmOcr() {
  if (ocrWorker || !navigator.onLine) return;
  (async () => { try { if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'); if (!ocrWorker) { ocrWorker = Tesseract.createWorker('deu'); ocrWorker.catch(() => { ocrWorker = null; }); } } catch (e) { /* später */ } })();
}

// =====================================================================
//  LISTE – alle Lieferungen
// =====================================================================
function renderList() {
  const v = $('#view-liste'), open = openStops(), done = doneStops();
  const sum = open.reduce((a, o) => a + (+o.amount || 0), 0);
  const cash = open.filter(o => o.pay === 'bar').reduce((a, o) => a + (+o.amount || 0), 0);
  const tg = currentTarget();
  v.innerHTML = `
    <div class="vh-row"><h1 class="vh">Liste</h1>
      <div>${open.length > 1 ? `<button class="ic big" type="button" data-act="opt" aria-label="Neu sortieren">${ic('lightning', true)}</button>` : ''}<button class="ic big dark" type="button" data-act="add" aria-label="Von Hand">${ic('plus')}</button></div></div>
    ${open.length ? `<p class="hint">${open.length} offen · CHF ${fr(sum)}${cash ? ` · ${ic('money', true)} ${fr(cash)} bar` : ''}</p>` : ''}
    ${open.length ? `<ol class="rows">${open.map((o, i) => {
      const c = db.customers[o.custId] || {}, late = lateBy(o), eta = lastRoute?.eta?.[o.id], isT = tg && tg.o && tg.o.id === o.id;
      return `<li class="rw ${isT ? 'now' : ''}" data-go="${o.id}">
        <span class="rw-n ${late > 0 ? 'late' : ''}">${i + 1}</span>
        <div class="rw-b"><b>${esc(c.street)}</b>${(o.items || []).length ? `<span class="rw-it">${o.items.slice(0, 4).map(it => it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy">` : '').join('')}<em>${esc(itemsLine(o.items))}</em></span>` : ''}<small>${esc(c.ort)} · ${o.pay === 'bar' ? ic('money', true) + ' ' + fr(o.amount) : payLabel(o.pay)}${o.time ? ' · bis ' + esc(o.time) : ''}${eta ? ' · an ' + tm(eta) : ''}${late > 0 ? ` · <span class="lt">${late}′ spät</span>` : ''}${c.lat == null ? ' · <span class="lt">⚠️ Punkt?</span>' : ''}</small></div>
        <div class="rw-a">${c.phone ? `<a class="ic" href="tel:${esc(c.phone)}" aria-label="Anrufen">${ic('phone', true)}</a>` : ''}<button class="ic" type="button" data-menu="${o.id}" aria-label="Mehr">${ic('dots-three')}</button></div>
      </li>`;
    }).join('')}</ol>` : '<div class="empty">Keine offenen Lieferungen.<br>Tippe unten auf 📷 und fotografiere die Zettel.</div>'}
    ${done.length ? `<h2>Erledigt (${done.length})</h2><ol class="rows done">${done.map(o => { const c = db.customers[o.custId] || {}; return `<li class="rw"><span class="rw-n">✓</span><div class="rw-b"><b>${esc(c.street)}</b><small>${esc(c.ort)} · CHF ${fr(o.amount)} · Trinkgeld ${fr(o.tip)}</small></div></li>`; }).join('')}</ol>
      <button class="btn block" type="button" data-act="cleardone">Erledigte entfernen</button>` : ''}`;
}
$('#view-liste').addEventListener('click', e => {
  const mn = e.target.closest('[data-menu]');
  if (mn) {
    const o = db.tour.find(x => x.id === mn.dataset.menu), c = o && db.customers[o.custId]; if (!o) return;
    const d = openDialog(`<h3>${esc(c?.street || '')}</h3>${itemsHtml(o.items, true)}
      <div class="bigbtns">
        <button class="btn primary" type="button" data-m="go">${ic('navigation-arrow', true)} Jetzt hinfahren</button>
        <button class="btn" type="button" data-m="cust">${ic('user-circle')} Kunde & Notizen</button>
        <button class="btn danger" type="button" data-m="del">${ic('trash')} Aus der Tour entfernen</button>
      </div>`);
    d.querySelector('[data-m="go"]').onclick = () => { closeDialog(); goTo(o.id); };
    d.querySelector('[data-m="cust"]').onclick = () => { closeDialog(); customerDialog(o.custId); };
    d.querySelector('[data-m="del"]').onclick = () => { closeDialog(); db.tour = db.tour.filter(x => x.id !== o.id); setRoute(null); save(); autoRoute(100); renderAll(); toast('Entfernt'); };
    return;
  }
  const cu = e.target.closest('[data-cust]'); if (cu) { customerDialog(cu.dataset.cust); return; }
  const del = e.target.closest('[data-del]'); if (del) { if (confirm('Lieferung entfernen?')) { db.tour = db.tour.filter(o => o.id !== del.dataset.del); setRoute(null); save(); autoRoute(100); renderAll(); } return; }
  if (e.target.closest('a')) return;
  const b = e.target.closest('[data-act]');
  if (b) { ({ cam: openCamera, add: () => orderDialog(), opt: () => optimizeTour(), cleardone: () => { db.tour = openStops(); save(); renderAll(); } })[b.dataset.act]?.(); return; }
  const go = e.target.closest('[data-go]'); if (go) goTo(go.dataset.go);
});
function renderBadge() { const n = openStops().length, b = $('#badge'); b.hidden = !n; b.textContent = n; }

// =====================================================================
//  ANSICHTEN
// =====================================================================
function renderAll() {
  renderBadge(); renderCard(); renderMapPois();
  if (current === 'liste') renderList();
  if (current === 'schicht') renderSchicht();
  if (current === 'kunden') renderKunden($('#kq')?.value || '');
}
function showView(name) {
  if (name === 'tour') name = 'liste';
  current = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.dock [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === name || (name === 'kunden' && b.dataset.view === 'einst')));
  if (name !== 'karte' && pick) endPick();
  if (name === 'karte') { initMap(); renderCard(); }
  if (name === 'liste') renderList();
  if (name === 'schicht') renderSchicht();
  if (name === 'einst') renderEinst();
  if (name === 'kunden') renderKunden($('#kq')?.value || '');
  const v = $('#view-' + name); v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
}
$('.dock').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) showView(b.dataset.view); });
// „Kunden“ aus „Mehr“ öffnen
document.addEventListener('click', e => { const k = e.target.closest('[data-open-kunden]'); if (k) showView('kunden'); });

function toastNet() { if (!navigator.onLine) toast('Offline – Karte & Adresssuche brauchen Internet', 3000); }
addEventListener('offline', toastNet);

// =====================================================================
//  START
// =====================================================================
(function start() {
  if (db.settings.pinHash) lockApp();
  applyRetention();
  renderBadge();
  if (!db.settings.base) geocode(SUBITO.street, SUBITO.plz, SUBITO.ort).then(p => { if (p && !db.settings.base) { db.settings.base = p; save(); renderAll(); } });
  startGps();
  let tries = 0;
  const tryMap = () => { if (typeof SearchChMap !== 'undefined') { initMap(); renderCard(); } else if (++tries < 100) setTimeout(tryMap, 300); else toast('Karte konnte nicht laden – Internet prüfen', 4000); };
  tryMap();
  setTimeout(warmOcr, 2000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.update();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
    }).catch(() => {});
    let reloaded = false; const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !had) return; reloaded = true; if (!$('#dlg').open && $('#cam').hidden) location.reload(); });
  }
})();
