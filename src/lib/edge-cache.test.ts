import { bindTestCredentialsIn } from "../platform/testing/credentials.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { bumpsStorefrontCache, edgeCachePath, edgeCacheRequest, isEdgeStorable, readEdgeCache, writeEdgeCache, writeUploadCache } from "./edge-cache.ts";

const req = (href: string, init?: RequestInit & { cf?: Record<string, unknown> }) => {
  const { cf, ...rest } = init ?? {};
  const request = new Request(href, rest);
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
};
const TENANT = { tenantId: "t-1", cacheVersion: 3 };
// The cases below are about path and query; the tenant prefix is asserted on its own.
const key = (href: string, init?: RequestInit & { cf?: Record<string, unknown> }) =>
  edgeCacheRequest(req(href, init), new URL(href), TENANT)?.url.replace("https://cache.adsbook.id/t/t-1/v3/", "https://") ?? null;

test("TEN-3/ISO-8: the key carries the tenant and its cache version; no tenant, no cache", () => {
  const href = "https://shop.example/produk/serum";
  const forTenant = (tenantId: string, cacheVersion: number) =>
    edgeCacheRequest(req(href), new URL(href), { tenantId, cacheVersion })?.url;
  assert.equal(forTenant("t-1", 3), "https://cache.adsbook.id/t/t-1/v3/shop.example/produk/serum");
  // A host moved to another tenant, or a version bump (suspend, hostname change), is a cold key.
  assert.notEqual(forTenant("t-2", 3), forTenant("t-1", 3));
  assert.notEqual(forTenant("t-1", 4), forTenant("t-1", 3));
  assert.equal(edgeCacheRequest(req(href), new URL(href), undefined), null);
});

test("only shared pages are eligible; per-visitor and geo test pages never are", () => {
  for (const path of [
    "/", "/produk", "/produk/", "/produk/aussie", "/produk/4g-lucky-spray-herbal-pria-dewasa/",
    "/aussie-formulabaru", "/kontak", "/Tentang",
  ]) {
    assert.ok(edgeCachePath(path), path);
  }
  for (const path of [
    "/produk/a/b", "/thanks", "/payment", "/hello", "/install", "/admin", "/admin/orders",
    "/api/geo-province", "/full-form", "/middle-form", "/hybrid-form", "/geoipform", "/embed/form",
    "/assets/uploads/x.webp", "/media/x", "/robots.txt", "/sitemap.xml", "/a/b",
  ]) {
    assert.equal(edgeCachePath(path), null, path);
  }
});

test("ad tracking parameters share one entry; real parameters, provinces and bypasses do not", () => {
  const base = "https://store.example/aussie-formulabaru";
  assert.equal(key(base), base);
  assert.equal(key(`${base}?utm_source=fb&utm_campaign=x&fbclid=abc&gclid=g&_fbp=fb.1.2.3`), base);
  assert.equal(key("https://store.example/produk?q=serum&kategori=Sawit"), "https://store.example/produk?kategori=Sawit&q=serum");
  assert.equal(key("https://store.example/produk?kategori=Sawit&q=serum&utm_source=fb"), "https://store.example/produk?kategori=Sawit&q=serum");
  // Product and landing pages partition by the visitor's normalized province code so
  // GeoIpResolvedForm's middle/full choice and prefilled province never leak across provinces.
  const product = "https://store.example/produk/wamena-oil";
  assert.equal(key(product, { cf: { regionCode: "JB" } }), `${product}?__prov=JB`);
  assert.equal(
    key(`${product}?fbclid=click1&utm_source=ig`, { cf: { region: "Jawa Barat" } }),
    `${product}?__prov=JB`,
  );
  assert.equal(key(product, { cf: { regionCode: "PA" } }), `${product}?__prov=PA`);
  assert.equal(key(base, { cf: { regionCode: "JK" } }), `${base}?__prov=JK`);
  // A query string `__prov` from the client cannot forge or collide with the server's province key.
  assert.equal(key(`${product}?__prov=PA`), product);
  assert.equal(key(`${product}?__prov=PA`, { cf: { regionCode: "JB" } }), `${product}?__prov=JB`);
  // Home and catalogue list do not embed a checkout form, so all provinces share one entry.
  assert.equal(key("https://store.example/", { cf: { regionCode: "JB" } }), "https://store.example/");
  assert.equal(key("https://store.example/produk", { cf: { regionCode: "JB" } }), "https://store.example/produk");
  // An admin session, an Authorization header, a preview and a non-GET never use the cache.
  assert.equal(key(base, { headers: { cookie: "__Host-adsbook_session=abc" } }), null);
  assert.equal(key(base, { headers: { cookie: "_fbp=x; __Host-adsbook_session=abc" } }), null);
  assert.equal(key(base, { headers: { authorization: "Bearer x" } }), null);
  assert.equal(key(`${base}?preview=1`), null);
  // The rewrite of a product page onto a native landing page's path.
  assert.equal(key(base, { headers: { "x-adsbook-product-page": "1" } }), null);
  assert.equal(key(base, { method: "POST", body: "x" }), null);
  assert.equal(key(`${base}?x=${"a".repeat(300)}`), null);
  // A visitor's other cookies do not matter: the page is the same for them.
  assert.equal(key(base, { headers: { cookie: "_fbp=fb.1.2.3; adsbook_click_ids=x" } }), base);
});

test("only a plain 200 html answer without cookies is stored", () => {
  const html = (init: ResponseInit = {}) => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...(init.headers as object) } });
  assert.equal(isEdgeStorable(html()), true);
  assert.equal(isEdgeStorable(html({ headers: { "set-cookie": "a=b" } })), false);
  assert.equal(isEdgeStorable(html({ headers: { "cache-control": "no-store" } })), false);
  assert.equal(isEdgeStorable(html({ headers: { "cache-control": "private, max-age=0" } })), false);
  assert.equal(isEdgeStorable(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })), false);
  assert.equal(isEdgeStorable(new Response("<html></html>", { status: 404, headers: { "content-type": "text/html" } })), false);
  assert.equal(isEdgeStorable(new Response(null, { status: 301, headers: { location: "/x" } })), false);
});

function fakeCache() {
  const map = new Map<string, Response>();
  return {
    map,
    async match(request: Request) { return map.get(request.url)?.clone(); },
    async put(request: Request, response: Response) { map.set(request.url, response); },
  };
}

test("a write is readable as a hit with the internal headers swapped for browser ones", async () => {
  const cache = fakeCache();
  const k = new Request("https://store.example/", { method: "GET" });
  assert.equal(await readEdgeCache(k, cache), null);
  writeEdgeCache(k, new Response("<p>home</p>", { status: 200, headers: { "content-type": "text/html" } }), undefined, cache);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stored = cache.map.get(k.url)!;
  assert.match(stored.headers.get("cache-control") ?? "", /max-age=120/);
  const hit = await readEdgeCache(k, cache);
  assert.equal(await hit!.text(), "<p>home</p>");
  assert.equal(hit!.headers.get("x-edge-cache"), "HIT");
  assert.equal(hit!.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(hit!.headers.has("x-edge-cached-at"), false);
  // Something that must not be shared is not written.
  const other = new Request("https://store.example/x", { method: "GET" });
  writeEdgeCache(other, new Response("p", { status: 200, headers: { "content-type": "text/html", "set-cookie": "a=b" } }), undefined, cache);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cache.map.has(other.url), false);
  // A broken cache never throws into the page.
  const broken = { match: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); } };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await readEdgeCache(k, broken), null);
    writeEdgeCache(k, new Response("p", { status: 200, headers: { "content-type": "text/html" } }), undefined, broken);
    await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    console.error = originalError;
  }
});

// The middleware itself: a hit must not touch D1, must still write the ad click id cookie, and
// must keep the security headers.
const STUB = "stub:astro-middleware";
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "astro:middleware") return { url: STUB, shortCircuit: true };
    try { return nextResolve(specifier, context); } catch (error) {
      if (!(specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier))) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (url === STUB) return { format: "module", source: "export const defineMiddleware = (handler) => handler;", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createMiddleware } = await import("../middleware.ts");
hooks.deregister();
let schemaCalls = 0;
// The request gate (T-17) is tested in src/platform/; these tests start past it, on an active tenant.
const tenantGate = async () => ({
  kind: 'tenant' as const,
  // Coherent with the request host (store.example) the tests send: the gate never
  // reports a subdomain whose primary is another host without that host being custom.
  tenant: { tenantId: 't-test', slug: 'test', status: 'active' as const, cacheVersion: 1, host: 'store.example', hostKind: 'custom' as const, primaryHost: 'store.example' },
});
const onRequest = createMiddleware(async (env) => { schemaCalls += 1; return (env as { OMS_DB: D1Database }).OMS_DB; }, tenantGate);

const READY_ROW = {
  store_name: 1, product: 1, primary_warehouse: 1, mengantar_api_key: "k", cod: 1, autolaris_on: 0, autolaris_key: null,
  autolaris_origin: null, autolaris_destination: null, warehouse_address: "Jl. 1", couriers: 1, signals: 0,
};

async function run(
  href: string,
  next: () => Promise<Response>,
  headers: Record<string, string> = {},
  cf?: Record<string, unknown>,
) {
  const request = req(href, { headers, cf });
  let d1Calls = 0;
  const schemaBefore = schemaCalls;
  const context = {
    request,
    url: new URL(href),
    locals: {
      runtimeEnv: {
        OMS_DB: bindTestCredentialsIn({
          // A ready store (T-38): the readiness read answers; every other read fails,
          // so the page renders from its defaults.
          prepare(sql: string) {
            d1Calls += 1;
            if (sql.includes("AS primary_warehouse")) return { first: async () => READY_ROW };
            throw new Error("d1 unavailable");
          },
        }),
      },
    },
    redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
  };
  const response = await onRequest(context as never, next as never);
  return {
    response: response as Response,
    d1Calls: () => d1Calls,
    schemaCalls: () => schemaCalls - schemaBefore,
  };
}

test("middleware: a hit skips D1 and the render, keeps security headers and writes the click id cookie", async (context) => {
  const cache = fakeCache();
  const original = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: cache };
  context.after(() => { (globalThis as { caches?: unknown }).caches = original; });
  const originalError = console.error;
  console.error = () => {};
  context.after(() => { console.error = originalError; });
  let renders = 0;
  const render = async () => { renders += 1; return new Response("<p>live render</p>", { status: 200, headers: { "content-type": "text/html" } }); };

  // First visitor renders and fills the cache; the entry holds no cookie and no security header.
  const first = await run("https://store.example/aussie-formulabaru?utm_source=fb&fbclid=abc123", render);
  assert.equal(await first.response.text(), "<p>live render</p>");
  assert.equal(first.response.headers.get("x-edge-cache"), "MISS");
  assert.equal(first.schemaCalls(), 1);
  assert.match(first.response.headers.get("set-cookie") ?? "", /adsbook_click_ids=/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const entry = cache.map.get("https://cache.adsbook.id/t/t-test/v1/store.example/aussie-formulabaru")!;
  assert.ok(entry, "stored under the key without ad parameters");
  assert.equal(entry.headers.has("set-cookie"), false);
  assert.equal(entry.headers.has("x-frame-options"), false);

  // The next visitor, from another ad, is served from the cache before the schema check or D1.
  const second = await run("https://store.example/aussie-formulabaru?gclid=gg99&utm_campaign=y", render);
  assert.equal(await second.response.text(), "<p>live render</p>");
  assert.equal(renders, 1, "not rendered again");
  assert.equal(second.schemaCalls(), 0, "schema check skipped on a hit");
  assert.equal(second.d1Calls(), 0, "D1 untouched");
  assert.equal(second.response.headers.get("x-edge-cache"), "HIT");
  assert.equal(second.response.headers.get("x-frame-options"), "DENY");
  assert.equal(second.response.headers.get("strict-transport-security"), "max-age=31536000");
  const cookie = second.response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /adsbook_click_ids=[^;]*gclid/);
  assert.equal(cookie.includes("fbclid=abc123"), false, "this visitor's ids, not the first visitor's");

  // Product pages share within a province and isolate between provinces.
  const jbFirst = await run(
    "https://store.example/produk/wamena-oil?fbclid=jb1",
    async () => { renders += 1; return new Response("<p>middle:Jawa Barat</p>", { status: 200, headers: { "content-type": "text/html" } }); },
    {},
    { regionCode: "JB" },
  );
  assert.equal(jbFirst.response.headers.get("x-edge-cache"), "MISS");
  await new Promise((resolve) => setTimeout(resolve, 10));

  const jbSecond = await run(
    "https://store.example/produk/wamena-oil?fbclid=jb2",
    async () => { renders += 1; return new Response("<p>unexpected</p>", { status: 200, headers: { "content-type": "text/html" } }); },
    {},
    { regionCode: "JB" },
  );
  assert.equal(jbSecond.response.headers.get("x-edge-cache"), "HIT");
  assert.equal(await jbSecond.response.text(), "<p>middle:Jawa Barat</p>");
  assert.equal(jbSecond.schemaCalls(), 0, "product hit skips schema check");
  assert.equal(jbSecond.d1Calls(), 0, "product hit skips D1");

  const paFirst = await run(
    "https://store.example/produk/wamena-oil?fbclid=pa1",
    async () => { renders += 1; return new Response("<p>full:Papua</p>", { status: 200, headers: { "content-type": "text/html" } }); },
    {},
    { regionCode: "PA" },
  );
  assert.equal(paFirst.response.headers.get("x-edge-cache"), "MISS");
  assert.equal(await paFirst.response.text(), "<p>full:Papua</p>");

  // An admin session never reads the cache.
  const admin = await run("https://store.example/aussie-formulabaru", async () => new Response("<p>preview</p>", { status: 200, headers: { "content-type": "text/html" } }), { cookie: "__Host-adsbook_session=abc" });
  assert.equal(await admin.response.text(), "<p>preview</p>");
  assert.notEqual(admin.response.headers.get("x-edge-cache"), "HIT");
});

test("middleware: an upload is fetched from R2 once, then served without D1 or the route", async (context) => {
  const cache = fakeCache();
  const original = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: cache };
  context.after(() => { (globalThis as { caches?: unknown }).caches = original; });
  const originalError = console.error;
  console.error = () => {};
  context.after(() => { console.error = originalError; });
  let reads = 0;
  const image = async () => { reads += 1; return new Response("webp-bytes", { status: 200, headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable" } }); };
  const href = "https://store.example/assets/uploads/2026-08-18/ccf44dda-90ac.webp";

  const first = await run(`${href}?v=1`, image);
  assert.equal(first.response.headers.get("x-edge-cache"), "MISS");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const entry = cache.map.get(`${href.replace("https://", "https://cache.adsbook.id/t/t-test/v1/")}?__g=2`)!;
  assert.ok(entry, "stored without the visitor's query string, under the current generation");
  assert.equal(entry.headers.get("cache-control"), "public, max-age=86400", "the edge keeps it a day");

  const second = await run(href, image);
  assert.equal(await second.response.text(), "webp-bytes");
  assert.equal(reads, 1, "R2 read once");
  assert.equal(second.d1Calls(), 0, "D1 untouched");
  assert.equal(second.response.headers.get("x-edge-cache"), "HIT");
  assert.equal(second.response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(second.response.headers.get("x-content-type-options"), "nosniff");

  // A missing upload is not remembered.
  const missing = `${href.replace("ccf44dda-90ac", "deadbeef")}`;
  await run(missing, async () => new Response("Not found", { status: 404 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.map.has(missing), false);
  assert.equal(cache.map.has(`${missing}?__g=2`), false);

  // A stand-in (the full image answering for a missing `-sm`) is not remembered
  // either: once the real derivative is stored, the next request must reach it.
  const card = href.replace(".webp", "-sm.webp");
  await run(card, async () => new Response("full-bytes", { status: 200, headers: { "content-type": "image/webp", "x-asset-stand-in": "1" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.map.has(`${card}?__g=2`), false);
});

test("an upload answer that is private, no-store or sets a cookie is never stored as public (T-28 review)", async () => {
  const stored: Response[] = [];
  const cache = { match: async () => undefined, put: async (_key: Request, response: Response) => void stored.push(response) };
  const key = new Request("https://toko-a.adsbook.my.id/uploads/a.webp");
  const image = (headers: Record<string, string>) => new Response("bytes", { status: 200, headers: { "content-type": "image/webp", ...headers } });
  writeUploadCache(key, image({ "cache-control": "private, max-age=60" }), undefined, cache);
  writeUploadCache(key, image({ "cache-control": "no-store" }), undefined, cache);
  writeUploadCache(key, image({ "set-cookie": "a=1; Path=/" }), undefined, cache);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stored.length, 0);
  writeUploadCache(key, image({ "cache-control": "public, max-age=60" }), undefined, cache);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stored.length, 1, "the control: a public upload is stored");
  assert.match(stored[0].headers.get("cache-control") ?? "", /^public/);
});

test("a cached copy survives garbage collection: the stored body is never a dropped clone's stream (CI run 43827214642)", async () => {
  // Node 22's undici cancels the body of a Response object once it is
  // collected. Forcing collections between the write and the read proves the
  // stored copy does not depend on an object nobody holds.
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const collect = async () => {
    for (let round = 0; round < 5; round += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const page = fakeCache();
  const pageKey = new Request("https://cache.adsbook.id/t/t-gc/v1/store.example/produk/x", { method: "GET" });
  writeEdgeCache(pageKey, new Response("<p>page</p>", { status: 200, headers: { "content-type": "text/html" } }), undefined, page);
  const upload = fakeCache();
  const uploadKey = new Request("https://cache.adsbook.id/t/t-gc/v1/uploads/a.webp", { method: "GET" });
  writeUploadCache(uploadKey, new Response("bytes", { status: 200, headers: { "content-type": "image/webp" } }), undefined, upload);
  await collect();
  const hit = await readEdgeCache(pageKey, page);
  assert.equal(hit?.headers.get("x-edge-cache"), "HIT");
  assert.equal(await hit?.text(), "<p>page</p>");
  assert.equal(await (await upload.match(uploadKey))?.text(), "bytes");
});

test("Paket 1: affiliate and social parameters share the page's entry", () => {
  const base = "https://store.example/aussie-formulabaru";
  assert.equal(key(`${base}?ref=budi&source=ig&igshid=abc&twclid=t1`), base);
  assert.equal(key(`${base}?ref=budi&varian=2`), `${base}?varian=2`);
});

test("Paket 1: a 2xx write to a storefront-visible admin API bumps the cache; reads, failures and other APIs do not", () => {
  for (const path of [
    "/api/admin/products", "/api/admin/landing-pages", "/api/admin/landing-pages/12", "/api/admin/settings",
    "/api/admin/settings/privacy", "/api/admin/ads", "/api/admin/whatsapp-numbers", "/api/admin/content",
    "/api/admin/seller-bank-accounts",
  ]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(bumpsStorefrontCache(path, method, 200), true, `${method} ${path}`);
  }
  assert.equal(bumpsStorefrontCache("/api/admin/products", "GET", 200), false);
  assert.equal(bumpsStorefrontCache("/api/admin/products", "PATCH", 400), false);
  assert.equal(bumpsStorefrontCache("/api/admin/products", "PATCH", 500), false);
  assert.equal(bumpsStorefrontCache("/api/admin/orders/5", "PATCH", 200), false);
  assert.equal(bumpsStorefrontCache("/api/admin/productsx", "POST", 200), false);
  assert.equal(bumpsStorefrontCache("/api/admin/profile", "PUT", 200), false);
});

