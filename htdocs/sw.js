// Service Worker version identifier
// Bump this version string with every deployment to force
// all PWA clients to evict the old cache and start fresh.
const SW_VERSION = '5.0';
const CACHE_NAME = `scuba-app-suite-v${SW_VERSION}`;

// Scanner engine files (OCR/image libraries and models) live in their own cache that has no version
// in its name, so it survives every SW_VERSION change. engine-loader.js fills it; files are never
// re-downloaded until the engine manifest lists a differently named file.
const ENGINE_CACHE = 'bingo-scan-engine';
const ENGINE_PATH = '/Bingo/scan/engine/';

// Static app-shell assets pre-cached on install for offline functionality.
// Includes the root launcher and entry points for all sub-applications.
const APP_SHELL = [
  './',
  './index.html',
  './about.html',
  './admin.html',
  './admin.css',
  './admin.js',
  './about.css',
  './manifest.json',
  './media/suite-header.css',
  './media/suite-profile.css',
  './media/suite-profile.js',
  './media/scuba.png',
  './media/scuba-192.png',
  './media/scuba-512.png',
  './media/scuba-maskable-512.png',
  './media/scuba_apple.png',
  './BagScore/',
  './BagScore/index.html',
  './BagScore/style.css',
  './Bingo/',
  './Bingo/index.html',
  './Bingo/style.css',
  './Bingo/tracking.js',
  './Bingo/game-creator.html',
  './Bingo/scan/scan.html',
  './Bingo/scan/style.css',
  './Bingo/scan/ocr.js',
  './Bingo/scan/utils.js',
  './Bingo/scan/imaging.js',
  './Bingo/scan/profiles.js',
  './Bingo/scan/geometry.js',
  './Bingo/scan/readers/tesseract-reader.js',
  './Bingo/scan/detection.css',
  './Bingo/scan/engine-loader.js',
  './Bingo/scan/engine-loader.css',
  './Bingo/scan/engine/manifest.json',
  './DriverScore/',
  './DriverScore/index.html',
  './DriverScore/style.css',
  './DriverScore/VehicleSettings.html',
  './FarkleScore/',
  './FarkleScore/index.html',
  './FarkleScore/styles.css',
  './FarkleScore/app.js',
  './FarkleScore/players.html',
  './FarkleScore/settings.html',
  './FarkleScore/standings.html',
  './HarleyVinDecoder/',
  './HarleyVinDecoder/index.html',
  './HarleyVinDecoder/style.css',
  './QueenCount/',
  './QueenCount/index.html',
  './QueenCount/history.html',
  './QueenCount/style.css',
  './QueenCount/theme.js',
  './QueenCount/qc-shared.js',
  './QueenCount/app.js',
  './QueenCount/history.js',
  './ScoreBoard/',
  './ScoreBoard/index.html',
  './ScoreBoard/scoreboard.css',
  './ScoreBoard/scoreboard-shared.js',
  './ScoreBoard/ScoreBoardGames.html',
  './ScoreBoard/ScoreBoardActiveGames.html',
  './ScoreBoard/ScoreBoardMyGames.html',
  './ScoreBoard/ScoreBoardViewer.html',
  './ScoreBoard/ScoreBoardHelp.html',
  './ScoreBoard/media/whistle.mp3',
  './Toys/',
  './Toys/index.html',
  './Toys/style.css',
  './Toys/toys.html'
];

// Determines whether a given request should be fetched network-first.
// All code assets, stylesheets, documents, and navigations are network-first
// so code changes are never stuck behind cached versions when online.
function isNetworkFirst(url, request) {
  const parsed = new URL(url);
  if (parsed.origin !== self.location.origin) return false;

  // Live database API endpoints are network-only
  if (parsed.pathname.includes('/api/')) return false;

  // Media files (heavy raster images and audio) use cache-first for performance
  const path = parsed.pathname.toLowerCase();
  const isMedia = /\.(png|jpe?g|gif|webp|ico|mp3|wav|ogg|woff2?|ttf|eot)$/.test(path);

  // Top-level navigation requests are always network-first
  if (request && request.mode === 'navigate') return true;

  // All other same-origin assets (html, js, css, json, svg) are network-first
  return !isMedia;
}

// True for scanner engine files that are served cache-first from ENGINE_CACHE.
// The engine manifest is excluded so it stays network-first like other app code.
function isEngineAsset(url) {
  return url.origin === self.location.origin &&
    url.pathname.includes(ENGINE_PATH) && !url.pathname.endsWith('/manifest.json');
}

// Serves an engine file from ENGINE_CACHE; on a miss it goes to the network without storing the
// result, because only engine-loader.js adds verified files to the cache.
function engineCacheFirst(request) {
  return caches.open(ENGINE_CACHE)
    .then(cache => cache.match(request))
    .then(hit => hit || fetch(request));
}

// Pre-cache the application shell across the root and all sub-apps on install
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        // Cache core assets safely without aborting install if one optional asset has a network error
        await Promise.allSettled(
          APP_SHELL.map(async url => {
            try {
              const res = await fetch(url, { cache: 'no-cache' });
              if (res.ok) {
                await cache.put(url, res);
              }
            } catch (err) {
              console.warn('Pre-cache miss for:', url, err);
            }
          })
        );
      })
      // Activate immediately without waiting for existing tabs to close
      .then(() => self.skipWaiting())
  );
});

// Remove stale caches from previous service worker versions on activation
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          // The engine cache is kept across versions
          .filter(key => key !== CACHE_NAME && key !== ENGINE_CACHE)
          .map(key => caches.delete(key))
      ))
      // Take control of all open clients and tabs immediately
      .then(() => self.clients.claim())
  );
});

// Fetch handler implementing network-first for code assets and cache-first for media
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests and same-origin requests
  if (request.method !== 'GET') return;
  let reqUrl;
  try { reqUrl = new URL(request.url); } catch { return; }

  // Scanner engine files: cache-first from the engine cache, never cache-busted
  if (isEngineAsset(reqUrl)) {
    event.respondWith(engineCacheFirst(request));
    return;
  }

  if (reqUrl.origin !== self.location.origin) return;

  // Bypass service worker cache completely for live database API endpoints
  if (reqUrl.pathname.includes('/api/')) return;

  if (isNetworkFirst(request.url, request)) {
    // Network-first: always fetch latest code from the server when online.
    // The 'no-cache' cache mode forces validation against the origin server.
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then(response => {
          // Store a fresh copy in the cache for offline fallback
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          // Network is unavailable (offline). Attempt cache retrieval with fallback paths.
          const cache = await caches.open(CACHE_NAME);

          // 1. Direct match with ignoreSearch to handle query parameters (?game_id=..., etc.)
          let cached = await cache.match(request, { ignoreSearch: true });
          if (cached) return cached;

          // 2. Try normalized path variations (e.g., directory slash vs index.html)
          const pathname = reqUrl.pathname;
          if (pathname.endsWith('/')) {
            cached = await cache.match(pathname + 'index.html', { ignoreSearch: true });
          } else if (pathname.endsWith('/index.html')) {
            cached = await cache.match(pathname.slice(0, -10), { ignoreSearch: true });
          } else if (!/\.[a-zA-Z0-9]+$/.test(pathname)) {
            cached = await cache.match(pathname + '/', { ignoreSearch: true }) ||
                     await cache.match(pathname + '/index.html', { ignoreSearch: true });
          }
          if (cached) return cached;

          // 3. Fallback to root index.html if navigating and no specific cache entry matched
          if (request.mode === 'navigate') {
            const fallback = await cache.match('./index.html') || await cache.match('./');
            if (fallback) return fallback;
          }

          return new Response('Network unavailable and resource not cached.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          });
        })
    );
  } else {
    // Cache-first: serve static media from cache; fetch from network and cache on miss
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
