// Offline-Speicher für die App-Hülle (v10). Karte, Adresssuche und Routen brauchen Internet.
const CACHE = 'subito-v12';
const SHELL = ['./', 'index.html', 'style.css?v=12', 'app.js?v=12', 'products.js?v=12', 'subito-logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Karte, Schrift, Dienste: direkt ins Netz
  // Zuerst beim Server nachfragen (neue Version sofort), offline die gespeicherte
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});
