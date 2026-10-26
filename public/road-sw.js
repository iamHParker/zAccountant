// The Road page's service worker: keeps a copy of the page so it opens with no signal.
// Network first (so an update arrives as soon as there is signal), the saved copy when offline. API calls are
// never cached: what the phone jots down waits in its own storage (IndexedDB) until it can be sent.
const CACHE = 'zacc-road-v5';
const FILES = ['/road', '/road.js', '/road.render.js', '/paste.js', '/clock.js', '/styles.css', '/vendor/vue.js', '/road.webmanifest', '/img/road-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !FILES.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
    return res;
  }).catch(() => caches.match(url.pathname)));
});
