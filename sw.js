// Offline-Speicher für die App-Hülle. Karten-Kacheln und Adresssuche brauchen Internet.
const CACHE = 'kurier-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'subito-logo.png', 'icon-192.png', 'apple-touch-icon.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin || url.hostname === 'unpkg.com';
  if (!isShell) return; // Kacheln, Adresssuche, Routen: direkt ins Netz
  // Zuerst Netz (damit Updates ankommen), sonst gespeicherte Version
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});
