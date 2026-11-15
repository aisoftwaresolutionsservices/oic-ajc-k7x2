/* sw.js - keeps a copy of every app file so OIC opens with no signal.
   RULE: every time you change ANY file in this list, change CACHE_VERSION,
   or phones keep showing the old copy. */
var CACHE_VERSION = 'oic-v2.2.0';
var FILES = ['./', './index.html', './app.js', './settings.js', './db.js', './ids.js', './pin.js',
             './store.js', './sync.js', './logo.jpg', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE_VERSION).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {          // remove old versions
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE_VERSION; })
                            .map(function (n) { return caches.delete(n); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;                  // never touch POST (the sync calls)
  if (new URL(e.request.url).origin !== self.location.origin) return;   // never touch Google or fonts
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});
