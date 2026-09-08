/* Wezo Expenses service worker (spec 13).
 *
 * Strategy
 *  - App shell + static assets: cache-first (Next hashes /_next/static, so it
 *    is safe to treat as immutable).
 *  - Navigations: network-first, falling back to the cached shell and then to
 *    /offline so the app always opens.
 *  - API GETs: network-first with a runtime cache fallback, so a phone that
 *    drops signal still shows the last known figures.
 *
 * Deliberately NOT cached (spec 14): anything under /api/auth (session
 * material) and /api/receipt (short-lived SAS URLs and receipt images). The
 * whole runtime cache is dropped on sign-out via a PURGE message from the page.
 *
 * Offline uploads are queued in IndexedDB by the page (lib/offline-queue.ts).
 * A background-sync event here just nudges open clients to drain that queue,
 * which keeps the multi-step upload logic in one place instead of duplicating
 * it in the worker.
 */

const VERSION = "wezo-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const API_CACHE = `${VERSION}-api`;

const SHELL_URLS = [
  "/offline",
  "/logo.svg",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const NEVER_CACHE = ["/api/auth", "/api/receipt", "/api/upload", "/api/ai"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individual failures must not abort the whole install.
      await Promise.allSettled(
        SHELL_URLS.map((u) => cache.add(new Request(u, { cache: "reload" }))),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "PURGE") {
    // Called on sign-out: leave no financial data at rest on the device.
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
    );
  }
  if (data.type === "SKIP_WAITING") self.skipWaiting();
});

/** Background sync: ask any open tab to flush the offline outbox. */
self.addEventListener("sync", (event) => {
  if (event.tag !== "wezo-outbox") return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) client.postMessage({ type: "DRAIN_OUTBOX" });
    })(),
  );
});

function isNeverCached(pathname) {
  return NEVER_CACHE.some((p) => pathname.startsWith(p));
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url.pathname)) return;

  // Navigations — always give the user *something*.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const shell = await caches.open(SHELL_CACHE);
          return (
            (await shell.match(request)) ??
            (await shell.match("/offline")) ??
            new Response("Offline", {
              status: 503,
              headers: { "content-type": "text/plain" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Immutable build output.
  if (
    url.pathname.startsWith("/_next/static") ||
    url.pathname.startsWith("/icons/")
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // API data — network-first (spec 13).
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      networkFirst(request, API_CACHE).catch(
        () =>
          new Response(
            JSON.stringify({ error: "You are offline.", offline: true }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    return;
  }

  // Everything else same-origin: cache-first with a network fill.
  event.respondWith(
    cacheFirst(request, STATIC_CACHE).catch(() => fetch(request)),
  );
});
