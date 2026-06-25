/* ═══════════════════════════════════════════════════════
   ajsites — Service Worker  v3.0.0
   Author : Anil Jakkula
   Strategy:
     - HTML navigation  → Network first, fallback to cache
     - CDN / static     → Cache first, update in background
     - Images (Unsplash)→ Cache first with 7-day TTL
     - Anything else    → Network first
═══════════════════════════════════════════════════════ */

const CACHE_VERSION  = 'ajsites-v3';
const CACHE_PAGES    = 'ajsites-pages-v3';
const CACHE_ASSETS   = 'ajsites-assets-v3';
const CACHE_IMAGES   = 'ajsites-images-v3';

const IMAGE_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

/* Assets to pre-cache on install */
const PRE_CACHE_ASSETS = [
  /* CDN CSS */
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://unpkg.com/aos@2.3.1/dist/aos.css',
  'https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css',
  /* CDN JS */
  'https://unpkg.com/aos@2.3.1/dist/aos.js',
  'https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js',
  'https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js',
  /* Local icon & PWA files */
  './favicon.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.json',
  /* Certificate PDFs */
  './Effective_Business_Websites.pdf',
  './Social_Media_Marketing.pdf',
];

const PRE_CACHE_PAGES = [
  '/',
  '/index.html',
];

/* ── INSTALL ─────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_ASSETS).then(cache =>
        Promise.allSettled(PRE_CACHE_ASSETS.map(url => cache.add(url)))
      ),
      caches.open(CACHE_PAGES).then(cache =>
        Promise.allSettled(PRE_CACHE_PAGES.map(url => cache.add(url)))
      ),
    ]).then(() => {
      console.log('[ajsites SW] Install complete — caches primed');
      return self.skipWaiting();
    })
  );
});

/* ── ACTIVATE ────────────────────────────────────────── */
self.addEventListener('activate', event => {
  const VALID = new Set([CACHE_VERSION, CACHE_PAGES, CACHE_ASSETS, CACHE_IMAGES]);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !VALID.has(k)).map(k => {
        console.log('[ajsites SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    ).then(() => {
      console.log('[ajsites SW] Activate complete');
      return self.clients.claim();
    })
  );
});

/* ── HELPERS ─────────────────────────────────────────── */
function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

function isCDNAsset(url) {
  return (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.svg')
  );
}

function isUnsplashImage(url) {
  return url.hostname.includes('images.unsplash.com');
}

function isExpired(response) {
  if (!response) return true;
  const dateHeader = response.headers.get('date');
  if (!dateHeader) return false;
  const age = Date.now() - new Date(dateHeader).getTime();
  return age > IMAGE_TTL_MS;
}

/* Network first — used for HTML pages */
async function networkFirst(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    /* Ultimate offline fallback */
    const fallback = await caches.match('/index.html');
    return fallback || new Response(
      '<h1 style="font-family:sans-serif;padding:2rem">You are offline</h1>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

/* Cache first — used for CDN assets */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return cached || new Response('', { status: 503 });
  }
}

/* Stale-while-revalidate with TTL — used for Unsplash images */
async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);

  const fetchAndCache = fetch(request).then(async networkResponse => {
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(() => cached);

  if (cached && !isExpired(cached)) {
    return cached; /* serve from cache, revalidate silently */
  }
  return fetchAndCache; /* wait for network if cache is expired/missing */
}

/* ── FETCH ───────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* Skip non-GET and cross-origin non-assets */
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  /* HTML navigation pages → Network first */
  if (isNavigationRequest(event.request)) {
    event.respondWith(networkFirst(event.request, CACHE_PAGES));
    return;
  }

  /* Unsplash images → Stale-while-revalidate (7-day TTL) */
  if (isUnsplashImage(url)) {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_IMAGES));
    return;
  }

  /* CDN assets (CSS, JS, fonts) → Cache first */
  if (isCDNAsset(url)) {
    event.respondWith(cacheFirst(event.request, CACHE_ASSETS));
    return;
  }

  /* Local files (icon.svg, manifest.json) → Cache first */
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request, CACHE_ASSETS));
    return;
  }

  /* Everything else → Network first */
  event.respondWith(networkFirst(event.request, CACHE_PAGES));
});

/* ── MESSAGE ─────────────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
