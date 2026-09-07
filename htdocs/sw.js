// Service Worker version identifier
// IMPORTANT: Bump this version string with every deployment to force
// all PWA clients to evict the old cache and start fresh.
const SW_VERSION = '2.0';
const CACHE_NAME = `scuba-app-suite-v${SW_VERSION}`;

// Static app-shell assets that should be pre-cached on install.
// Keep this list small — only the root index and icons.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './media/scuba.png',
  './media/scuba_apple.png'
];

// File extensions that should always be fetched network-first so that
// code and style updates are reflected immediately on every load.
// Media files (images, fonts) still use cache-first for performance.
const NETWORK_FIRST_EXTENSIONS = ['.html', '.js', '.css', '.php', '.json'];

function isNetworkFirst(url) {
  // Always use network-first for same-origin navigations and code assets
  const parsed = new URL(url);
  if (parsed.origin !== self.location.origin) return false;
  const path = parsed.pathname.toLowerCase();
  return NETWORK_FIRST_EXTENSIONS.some(ext => path.endsWith(ext)) || path === '/';
}

// ---- Install: pre-cache the app shell ----
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      // Activate immediately — don't wait for old tabs to close
      .then(() => self.skipWaiting())
  );
});

// ---- Activate: delete all old caches ----
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))   // removes stale caches from old SW versions
      ))
      .then(() => self.clients.claim())     // take control of open tabs immediately
  );
});

// ---- Fetch: network-first for code assets, cache-first for media ----
self.addEventListener('fetch', event => {
  const { request } = event;

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET') return;
  let reqUrl;
  try { reqUrl = new URL(request.url); } catch { return; }
  if (reqUrl.origin !== self.location.origin) return;

  if (isNetworkFirst(request.url)) {
    // Network-first: always try to get the latest version from the server.
    // The no-cache pragma ensures intermediate proxies don't serve stale content.
    // Only falls back to the cache if the network is unavailable (offline).
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then(response => {
          // Store a fresh copy in the cache for offline fallback
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./index.html')))
    );
  } else {
    // Cache-first: serve media/fonts from cache; fetch and cache on miss
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
