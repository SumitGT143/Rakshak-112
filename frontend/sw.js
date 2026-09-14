/**
 * Rakshak 112 — Offline Service Worker
 * Network-First strategy with Offline Cache Fallback for Citizen PWA.
 * Command Center / Control Room is ALWAYS network-direct and NEVER cached.
 */

const CACHE_NAME = 'rakshak-112-v15';
const STATIC_ASSETS = [
  './',
  'index.html',
  'js/emergency-outbox.js',
  'js/i18n.js',
  'js/rakshak-bridge.js',
  'locales/en.js',
  'locales/hi.js',
  'locales/bn.js',
  'locales/mr.js',
  'locales/te.js',
  'locales/ta.js',
  'locales/gu.js',
  'locales/kn.js',
  'locales/ml.js',
  'locales/or.js',
  'locales/pa.js',
  'locales/as.js',
  'locales/mai.js',
  'locales/sat.js',
  'locales/ks.js',
  'locales/ne.js',
  'locales/kok.js',
  'locales/mni.js',
  'locales/doi.js',
  'locales/sd.js',
  'locales/brx.js',
  'locales/gon.js',
  'locales/bhb.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Caching notice on install:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          console.log('[SW] Purging cache:', key);
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Never cache Control Room, Command Center, live monitoring, API, or real-time JS in Service Worker
  if (
    url.pathname.includes('control') ||
    url.pathname.includes('live-monitoring') ||
    url.pathname.includes('app.js') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/events') ||
    url.pathname.startsWith('/fsws')
  ) {
    return; // Pass-through to live network directly without SW interception
  }

  // 2. Network-First with offline fallback for Citizen App assets
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('index.html');
          }
        });
      })
  );
});
