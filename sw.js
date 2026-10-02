// Offline shell for 破码 TANGO.
//
// NETWORK-FIRST for every same-origin subresource. A hand-written VERSION plus cache-first is how
// a deploy ends up serving a new index.html against old js/main.js — the HTML is not cached, the
// module graph is, and the page then dies in a way that only reproduces on the second visit. So
// the network always answers when it can, and the cache is only the fallback that keeps a
// installed PWA playable on a plane. VERSION exists to name the cache and to retire the old one,
// not to decide who answers a request.
//
// The game is a static ES-module build with no server state, so "offline" is a real feature here:
// the codebook pool ships in js/data/lots.js and the save file is localStorage.

const VERSION = 'tango-cos-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/game.css',
  './js/main.js',
  './js/view.js',
  './js/core/codes.js',
  './js/core/game.js',
  './js/core/library.js',
  './js/core/storage.js',
  './js/core/rng.js',
  './js/core/decide.js',
  './js/core/minimax.js',
  './js/core/book.js',
  './js/core/make.js',
  './js/core/table.js',
  './js/core/budget.js',
  './js/data/lots.js',
  './assets/img/pegboard.png',
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './assets/img/apple-touch-icon.png',
  './assets/img/icon-16.png',
  './assets/img/icon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // One missing file must not abort the whole precache: `allOrNothing` is the default of
      // Promise.all, and a partial cache still leaves the game playable offline.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function sameOriginGet(request) {
  if (request.method !== 'GET') return false;
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch (err) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!sameOriginGet(request)) return;
  event.respondWith((async () => {
    let networkError = null;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && fresh.type !== 'opaque') {
        const cache = await caches.open(VERSION);
        cache.put(request, fresh.clone()).catch(() => { /* quota, opaque, or a blob response */ });
      }
      return fresh;
    } catch (err) {
      networkError = err;
    }
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;
    // A navigation offline gets the shell, so an installed PWA still opens on the last build.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw networkError;
  })());
});
