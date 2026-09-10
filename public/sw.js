/* Wezo Expenses service worker (spec 13).
 *
 * Strategy
 *  - App shell + hashed build output + static files: cache-first (Next hashes
 *    /_next/static, so it is safe to treat as immutable).
 *  - Navigations: network-first, falling back to the cached shell and then to
 *    /offline so the app always opens.
 *  - API GETs and in-app navigation payloads: network-first with a runtime
 *    cache fallback, so a phone that drops signal still shows the last known
 *    figures, but a phone with signal always shows the current ones.
 *
 * ONLY content whose URL changes when the content changes may be cache-first.
 * That rules out far more than it first appears: an in-app navigation does not
 * issue a `navigate` request at all. Next fetches a React Server Component
 * payload for the destination — a normal same-origin GET carrying an `rsc`
 * header and an `_rsc=` query param, with request.mode "cors". A catch-all
 * cache-first branch therefore swallowed every page's data and replayed it
 * forever: a device that opened a page before some records existed kept showing
 * the empty version indefinitely, while other devices showed the truth. The
 * `_rsc` parameter exists to *defeat* intermediate caches; treating it as a
 * cache key inverted its purpose.
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

// Bumped to v2 to evict caches poisoned by the cache-first bug described above.
const VERSION = "wezo-v2";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const API_CACHE = `${VERSION}-api`;
const PAGE_CACHE = `${VERSION}-pages`;

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
      const stale = keys.filter((k) => !k.startsWith(VERSION));
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();

      // An upgrade evicts caches, but the tab on screen is still showing
      // whatever the old worker last served it. Claiming does not re-render, so
      // ask open pages to pull fresh data — otherwise the fix only becomes
      // visible the next time the user happens to reload, which on an installed
      // PWA may be days away.
      if (stale.length > 0) {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) client.postMessage({ type: "REFRESH" });
      }
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

/**
 * A React Server Component payload — what an in-app navigation actually
 * fetches. It looks like an ordinary GET for the page's own path, so the only
 * way to tell it apart is the header Next sets or its cache-busting query
 * param. Checking both: the header is authoritative, the param survives cases
 * where headers are not exposed.
 */
function isRscRequest(request, url) {
  return request.headers.has("rsc") || url.searchParams.has("_rsc");
}

/**
 * Files whose contents cannot change without the URL changing too — hashed
 * bundles, fonts, images. Anything not matching is dynamic by default, which is
 * the safe way round: a missed asset is a wasted request, a wrongly cached page
 * is wrong data on screen.
 */
const STATIC_ASSET =
  /\.(?:css|js|mjs|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i;

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) ?? (await caches.match(request));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  // Fall back to any cache, so shell entries precached under a different name
  // still answer on a cold, offline start.
  const cached = (await cache.match(request)) ?? (await caches.match(request));
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

  // In-app navigation payloads. These carry live figures, so they are treated
  // exactly like API data: fresh whenever the network allows, last-known
  // otherwise. Checked before the extension test below, because the URL is the
  // page's own path and may well end in something that looks like a file.
  if (isRscRequest(request, url)) {
    // No synthetic fallback: if there is nothing cached, let the request fail
    // so Next falls back to a full page load rather than rendering a payload
    // the router cannot parse.
    event.respondWith(networkFirst(request, PAGE_CACHE));
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

  // Genuinely static files.
  if (STATIC_ASSET.test(url.pathname)) {
    event.respondWith(
      cacheFirst(request, STATIC_CACHE).catch(() => fetch(request)),
    );
    return;
  }

  // Everything else same-origin is dynamic — the manifest, any HTML fetched
  // without a navigation. Network-first, never cache-first.
  event.respondWith(networkFirst(request, PAGE_CACHE));
});
