// Cache-first service worker. Two logical tiers, versioned together so a
// single CACHE_VERSION bump forces clients to refetch everything (e.g. after
// re-vendoring Tesseract.js — see CLAUDE.md).
'use strict';

const CACHE_VERSION = 'v4';
const SHELL_CACHE = `neoredact-shell-${CACHE_VERSION}`;
const OCR_CACHE = `neoredact-ocr-${CACHE_VERSION}`;
const ALL_CACHES = [SHELL_CACHE, OCR_CACHE];

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './codenames.js',
  './camera-capture.js',
  './canvas-annotator.js',
  './redactor.js',
  './ocr-engine.js',
  './export.js',
  './auth.js',
  './sync.js',
  './app.js',
  './icons/icon-16.png',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico',
];

// The large, one-time-download tier. Kept in its own cache so it's easy to
// reason about separately (e.g. size, eviction) from the small app shell.
const OCR_FILES = [
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/tesseract-core-lstm.wasm',
  './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/tesseract-core-simd-lstm.wasm',
  './vendor/tesseract/eng.traineddata.gz',
  './vendor/tesseract/tha.traineddata.gz',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);
      await shellCache.addAll(SHELL_FILES);
      const ocrCache = await caches.open(OCR_CACHE);
      await ocrCache.addAll(OCR_FILES);
      // Take over immediately so the very first install can still serve
      // itself offline without requiring the nurse to reload the app once
      // more first.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('neoredact-') && !ALL_CACHES.includes(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Cache-first for everything same-origin: serve from cache when present, else
// hit the network and stash a copy for next time. This is intentionally the
// same policy for both tiers — simple, predictable, and correct for static,
// versioned assets that never change without a CACHE_VERSION bump.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      try {
        const response = await fetch(event.request);
        if (response && response.ok) {
          const targetCache = url.pathname.includes('/vendor/tesseract/') ? OCR_CACHE : SHELL_CACHE;
          const cache = await caches.open(targetCache);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (err) {
        // Truly offline with nothing cached for this request — nothing more
        // we can do; let the failure surface to the caller.
        throw err;
      }
    })()
  );
});
