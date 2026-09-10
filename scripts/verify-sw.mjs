/**
 * Service worker caching contract.
 *
 * Loads the real public/sw.js into a stubbed ServiceWorkerGlobalScope and
 * asserts which strategy each kind of request actually receives. Written after
 * a bug that showed one device "0 recurring rules" while another showed 8: a
 * catch-all cache-first branch was capturing React Server Component payloads —
 * which is what an in-app navigation fetches — and replaying them forever.
 *
 * The rule this file exists to hold: only a URL that changes when its content
 * changes may be served cache-first. Everything else must reach the network
 * when the network is available.
 *
 *   node scripts/verify-sw.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const SW_PATH =
  process.env.SW_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js");
const SW = readFileSync(SW_PATH, "utf8");

let networkCalls = [];
let networkBody = "v1";
let networkFails = false;

function makeScope() {
  const stores = new Map();
  const listeners = new Map();

  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(request) {
        const hit = store.get(new URL(request.url).pathname + new URL(request.url).search);
        return hit ? new Response(hit, { status: 200 }) : undefined;
      },
      async put(request, response) {
        store.set(
          new URL(request.url).pathname + new URL(request.url).search,
          await response.text(),
        );
      },
      async add(request) {
        store.set(new URL(request.url).pathname, "shell");
      },
    };
  };

  const caches = {
    open: async (name) => openCache(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (request) => {
      for (const name of stores.keys()) {
        const hit = await (await openCache(name)).match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const self = {
    location: { origin: "https://expense.wezo.co" },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: {},
  };

  const sandbox = {
    self,
    caches,
    Response,
    Request,
    Headers,
    URL,
    console,
    fetch: async (request) => {
      const url = typeof request === "string" ? request : request.url;
      networkCalls.push(new URL(url).pathname + new URL(url).search);
      if (networkFails) throw new Error("offline");
      return new Response(networkBody, { status: 200 });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW, sandbox);

  return { listeners, stores, caches };
}

/** Dispatch a fetch event; returns { body, intercepted }. */
async function run(scope, url, { headers = {}, mode = "cors", method = "GET" } = {}) {
  const request = new Request(url, { method, headers });
  Object.defineProperty(request, "mode", { value: mode, configurable: true });
  let responded = null;
  const event = {
    request,
    respondWith: (p) => {
      responded = p;
    },
    waitUntil: () => {},
  };
  for (const fn of scope.listeners.get("fetch") ?? []) fn(event);
  if (!responded) return { intercepted: false, body: null };
  try {
    const res = await responded;
    return { intercepted: true, body: await res.text() };
  } catch (e) {
    return { intercepted: true, body: null, error: e.message };
  }
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}

const ORIGIN = "https://expense.wezo.co";

// ---------------------------------------------------------------------------
console.log("\n1. RSC navigation payload must NEVER be served stale");
{
  const scope = makeScope();
  networkBody = "rules:0";
  networkCalls = [];
  const first = await run(scope, `${ORIGIN}/recurring?_rsc=1a2b`, {
    headers: { rsc: "1" },
  });
  check("first visit hits the network", networkCalls.length === 1, networkCalls.join(","));
  check("first visit returns live payload", first.body === "rules:0", String(first.body));

  // Data changes on the server (rules created on another device).
  networkBody = "rules:8";
  networkCalls = [];
  const second = await run(scope, `${ORIGIN}/recurring?_rsc=1a2b`, {
    headers: { rsc: "1" },
  });
  check("revisit hits the network again", networkCalls.length === 1, networkCalls.join(","));
  check(
    "revisit returns the NEW payload (the reported bug)",
    second.body === "rules:8",
    `got ${second.body}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n2. RSC detected by query param alone (headers not exposed)");
{
  const scope = makeScope();
  networkBody = "a";
  await run(scope, `${ORIGIN}/dashboard?_rsc=xyz`);
  networkBody = "b";
  networkCalls = [];
  const again = await run(scope, `${ORIGIN}/dashboard?_rsc=xyz`);
  check("still network-first", networkCalls.length === 1);
  check("returns fresh", again.body === "b", `got ${again.body}`);
}

// ---------------------------------------------------------------------------
console.log("\n3. RSC still works offline (falls back to last known)");
{
  const scope = makeScope();
  networkBody = "rules:8";
  networkFails = false;
  await run(scope, `${ORIGIN}/recurring?_rsc=1a2b`, { headers: { rsc: "1" } });
  networkFails = true;
  const offline = await run(scope, `${ORIGIN}/recurring?_rsc=1a2b`, {
    headers: { rsc: "1" },
  });
  networkFails = false;
  check("offline serves the cached payload", offline.body === "rules:8", `got ${offline.body}`);
}

// ---------------------------------------------------------------------------
console.log("\n4. Hashed build output stays cache-first (no wasted requests)");
{
  const scope = makeScope();
  networkBody = "bundle";
  await run(scope, `${ORIGIN}/_next/static/chunks/main-abc123.js`);
  networkCalls = [];
  const second = await run(scope, `${ORIGIN}/_next/static/chunks/main-abc123.js`);
  check("served from cache, no network", networkCalls.length === 0, networkCalls.join(","));
  check("body correct", second.body === "bundle");
}

// ---------------------------------------------------------------------------
console.log("\n5. Static files by extension stay cache-first");
{
  const scope = makeScope();
  networkBody = "svg";
  await run(scope, `${ORIGIN}/logo.svg`);
  networkCalls = [];
  await run(scope, `${ORIGIN}/logo.svg`);
  check("logo.svg from cache", networkCalls.length === 0, networkCalls.join(","));
}

// ---------------------------------------------------------------------------
console.log("\n6. API data is network-first");
{
  const scope = makeScope();
  networkBody = '{"n":1}';
  await run(scope, `${ORIGIN}/api/transactions`);
  networkBody = '{"n":2}';
  networkCalls = [];
  const second = await run(scope, `${ORIGIN}/api/transactions`);
  check("hits network", networkCalls.length === 1);
  check("returns fresh", second.body === '{"n":2}', `got ${second.body}`);
}

// ---------------------------------------------------------------------------
console.log("\n7. Session and receipt traffic is never intercepted");
{
  const scope = makeScope();
  for (const p of ["/api/auth/session", "/api/receipt/abc", "/api/upload", "/api/ai/parse"]) {
    const r = await run(scope, `${ORIGIN}${p}`);
    check(`${p} passes through untouched`, r.intercepted === false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n8. Mutations and cross-origin are never intercepted");
{
  const scope = makeScope();
  const post = await run(scope, `${ORIGIN}/api/transactions`, { method: "POST" });
  check("POST not intercepted", post.intercepted === false);
  const other = await run(scope, "https://example.com/x.js");
  check("cross-origin not intercepted", other.intercepted === false);
}

// ---------------------------------------------------------------------------
console.log("\n9. A page path that looks like a file is still treated as RSC");
{
  const scope = makeScope();
  networkBody = "p1";
  await run(scope, `${ORIGIN}/reports/export.csv?_rsc=q`, { headers: { rsc: "1" } });
  networkBody = "p2";
  networkCalls = [];
  const again = await run(scope, `${ORIGIN}/reports/export.csv?_rsc=q`, {
    headers: { rsc: "1" },
  });
  check("RSC check precedes the extension check", again.body === "p2", `got ${again.body}`);
}

// ---------------------------------------------------------------------------
console.log("\n10. Old poisoned caches are evicted on activate");
{
  const scope = makeScope();
  await scope.caches.open("wezo-v1-static");
  await scope.caches.open("wezo-v1-api");
  await scope.caches.open("wezo-v2-pages");
  const waits = [];
  for (const fn of scope.listeners.get("activate") ?? [])
    fn({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const left = await scope.caches.keys();
  check(
    "v1 caches gone, v2 kept",
    !left.some((k) => k.startsWith("wezo-v1")) && left.includes("wezo-v2-pages"),
    left.join(","),
  );
}

const failed = results.filter((r) => !r.pass);
console.log("\n==================================================");
console.log(`  PASSED: ${results.length - failed.length}    FAILED: ${failed.length}`);
console.log("==================================================");
process.exit(failed.length ? 1 : 0);
