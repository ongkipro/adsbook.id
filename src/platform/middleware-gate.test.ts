// T-17: the gate at the head of the real middleware. A refused host never
// reaches a cache, the tenant schema check, the store lookup or the route.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import type { MigrationSource } from "../lib/schema-version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const STUB = "stub:astro-middleware";
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "astro:middleware") return { url: STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[a-z0-9]+$/i.test(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (url === STUB) return { format: "module", source: "export const defineMiddleware = (handler) => handler;", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createMiddleware } = await import("../middleware.ts");
const { gateRequest } = await import("./gate.ts");
hooks.deregister();

const dir = new URL("./migrations/", import.meta.url);
const CHAIN: MigrationSource[] = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

const platformDb = createSqliteD1();
await ensureControlPlane(platformDb, CHAIN);
platformDb.sqlite.exec(`
  INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES
    ('t-a', 'toko-a', 'a@example.test', 'active', '2026-11-16'),
    ('t-s', 'toko-s', 's@example.test', 'suspended', '2026-11-16'),
    ('t-r', 'toko-r', 'r@example.test', 'recovery', '2026-11-16');
  INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES
    ('toko-a.adsbook.my.id', 't-a', 'subdomain', 'active', 1, '2026-11-16'),
    ('toko-s.adsbook.my.id', 't-s', 'subdomain', 'active', 1, '2026-11-16'),
    ('toko-r.adsbook.my.id', 't-r', 'subdomain', 'active', 1, '2026-11-16');
`);

const onRequest = createMiddleware(async (env) => (env as { OMS_DB: D1Database }).OMS_DB, (request, url, env) =>
  gateRequest(request, url, env, { ensureSchema: async () => undefined }),
);

async function run(href: string, routePattern = "/produk/[slug]", nextImpl?: () => Promise<Response>, env: Record<string, unknown> = {}) {
  const touched: string[] = [];
  // Not a thenable (`await` reads `then`); every other property records the touch.
  const omsDb = new Proxy({}, { get: (_target, property) => (property === "then" ? undefined : (touched.push(`OMS_DB.${String(property)}`), () => { throw new Error("tenant database touched"); })) });
  const cacheReads: string[] = [];
  const previousCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: { match: async (key: Request) => (cacheReads.push(key.url), undefined), put: async () => undefined } };
  const logs: string[] = [];
  const previousLog = console.log;
  console.log = (line: unknown) => void logs.push(String(line));
  let nextCalls = 0;
  const nextArgs: unknown[] = [];
  const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, OMS_DB: omsDb, ...env } };
  try {
    const response = (await Promise.resolve(onRequest(
      {
        request: new Request(href),
        url: new URL(href),
        locals,
        routePattern,
        redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
      } as never,
      (async (payload?: unknown) => {
        nextCalls += 1;
        nextArgs.push(payload);
        return nextImpl ? nextImpl() : new Response("route", { status: 200 });
      }) as never,
    )).catch((error: unknown) => error)) as Response | Error;
    return { response: response as Response, error: response instanceof Error ? response : null, touched, cacheReads, nextCalls, nextArgs, locals, logs: logs.map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    console.log = previousLog;
    (globalThis as { caches?: unknown }).caches = previousCaches;
  }
}

test("a refused host never reaches a cache, the tenant database or the route", async () => {
  for (const [href, status] of [
    ["https://nobody.adsbook.my.id/produk/x", 404],
    ["https://toko-s.adsbook.my.id/produk/x", 403],
    ["https://toko-r.adsbook.my.id/produk/x", 503],
    ["https://adsbook.id/produk/x", 404],
    ["https://toko-a.adsbook.my.id/platform/admin", 404],
  ] as const) {
    const result = await run(href);
    assert.equal(result.response.status, status, href);
    assert.equal(result.nextCalls, 0, `${href}: route ran`);
    assert.deepEqual(result.cacheReads, [], `${href}: cache read before resolution`);
    assert.deepEqual(result.touched, [], `${href}: tenant database touched`);
    assert.equal(result.locals.tenantContext, undefined);
    assert.equal(result.logs.length, 1, "one log line per request");
    assert.equal(result.logs[0].status, status);
  }
});

test("an active tenant host reaches the route with its tenant on locals and in the log", async () => {
  const result = await run("https://toko-a.adsbook.my.id/api/webhooks/autolaris/secret-token-123?phone=6281234567890", "/api/webhooks/autolaris");
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(
    { id: (result.locals.tenantContext as { tenantId: string }).tenantId, primary: (result.locals.tenantContext as { primaryHost: string }).primaryHost },
    { id: "t-a", primary: "toko-a.adsbook.my.id" },
  );
  assert.equal(result.locals.platform, undefined);
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].tenant_id, "t-a");
  assert.equal(result.logs[0].host_kind, "tenant");
  assert.equal(result.logs[0].route, "/api/webhooks/autolaris");
  assert.doesNotMatch(JSON.stringify(result.logs[0]), /secret-token-123|6281234567890/);
});

test("a platform route on a platform host runs with platform context and no tenant work", async () => {
  // A public platform route (T-27: every other one needs a platform session).
  const result = await run("https://adsbook.id/platform/signup", "/platform/signup");
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.locals.platform, { host: "adsbook.id" });
  assert.equal(result.locals.tenantContext, undefined);
  assert.deepEqual(result.touched, []);
  assert.deepEqual(result.cacheReads, []);
  assert.equal(result.logs[0].host_kind, "platform");
  assert.equal(result.logs[0].tenant_id, null);

  const guarded = await run("https://adsbook.id/platform/health", "/platform/health");
  assert.equal(guarded.nextCalls, 0, "platform admin without a platform session");
  assert.equal(guarded.response.status, 302);
});

test("exactly one log line on every path: a gate refusal with its reason, and a route that throws", async () => {
  const down = await run("https://toko-a.adsbook.my.id/produk/x", "/produk/[slug]", undefined, { PLATFORM_DB: undefined });
  assert.equal(down.response.status, 503);
  assert.equal(down.logs.length, 1);
  assert.equal(down.logs[0].reason, "platform_db_unbound");

  const thrown = await run("https://adsbook.id/platform/signup", "/platform/signup", async () => {
    throw new Error("route failed");
  });
  assert.equal(thrown.error?.message, "route failed");
  assert.equal(thrown.logs.length, 1);
  assert.deepEqual({ status: thrown.logs[0].status, reason: thrown.logs[0].reason, host_kind: thrown.logs[0].host_kind }, { status: 500, reason: "unhandled_exception", host_kind: "platform" });
});

test("T-40: the marketing site's public paths render their /platform pages on a platform host only", async () => {
  for (const [href, target] of [
    ["https://adsbook.id/", "/platform/site"],
    ["https://adsbook.id/fitur", "/platform/site/fitur"],
    ["https://adsbook.id/harga/", "/platform/site/harga"],
    ["https://adsbook.id/daftar", "/platform/signup"],
    ["https://adsbook.id/syarat", "/platform/syarat"],
    ["https://adsbook.id/sitemap.xml", "/platform/site/sitemap.xml"],
  ] as const) {
    const result = await run(href, "/");
    assert.equal(result.response.status, 200, href);
    assert.deepEqual(result.nextArgs, [target], `${href} renders ${target}`);
    assert.notEqual(result.response.headers.get("cache-control"), "private, no-store", `${href}: a public page is not marked private`);
    assert.deepEqual(result.touched, [], `${href}: no tenant database`);
  }
  // Anything else on the platform host is still a 404, and the admin still needs a session.
  assert.equal((await run("https://adsbook.id/produk/x", "/")).response.status, 404);
  assert.equal((await run("https://adsbook.id/platform/health", "/")).response.status, 302);
  // On a seller host the same paths stay the seller's own: never rewritten to a platform page.
  for (const path of ["/", "/fitur", "/harga", "/faq", "/kontak", "/daftar", "/sitemap.xml", "/robots.txt"]) {
    const result = await run(`https://toko-a.adsbook.my.id${path}`, "/");
    assert.equal(result.logs[0].host_kind, "tenant", path);
    assert.ok(!result.nextArgs.some((arg) => typeof arg === "string" && arg.startsWith("/platform")), `${path} on a seller host reached a platform page`);
  }
});

test("PLATFORM-SEO §1–2: /coba moves to the home for good; register, login, console and APIs carry noindex; the console host never shows the site", async () => {
  // The retired page: 301 to the home, query kept for old ad links; only GET/HEAD move.
  for (const [href, location] of [["https://adsbook.id/coba", "/"], ["https://adsbook.id/coba/?utm_source=meta&fbclid=abc", "/?utm_source=meta&fbclid=abc"]] as const) {
    const moved = await run(href, "/");
    assert.equal(moved.response.status, 301, href);
    assert.equal(moved.response.headers.get("location"), location);
    assert.equal(moved.nextCalls, 0);
    assert.equal(moved.response.headers.get("x-robots-tag"), null, "the site's own redirect is not a noindex page");
  }
  // The console host: its root opens the console, and every answer is noindex.
  const consoleRoot = await run("https://app.adsbook.id/", "/");
  assert.equal(consoleRoot.response.status, 302);
  assert.equal(consoleRoot.response.headers.get("location"), "/platform");
  assert.equal(consoleRoot.response.headers.get("x-robots-tag"), "noindex, nofollow");
  // Review P2-3: the console host is never the site — a marketing path moves to adsbook.id, anything else is a 404.
  for (const path of ["/fitur", "/harga?utm_source=x", "/daftar", "/masuk", "/sitemap.xml", "/llms.txt", "/coba"]) {
    const moved = await run(`https://app.adsbook.id${path}`, "/");
    assert.equal(moved.response.status, 301, `app.adsbook.id${path}`);
    assert.equal(moved.response.headers.get("location"), `https://adsbook.id${path === "/coba" ? "/" : path}`);
    assert.equal(moved.response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(moved.nextCalls, 0);
  }
  for (const [path, method] of [["/fitur", "POST"], ["/api/v1/products", "GET"], ["/produk/x", "GET"]] as const) {
    const refused = await (async () => {
      const previous = console.log;
      console.log = () => undefined;
      try {
        return await onRequest({ request: new Request(`https://app.adsbook.id${path}`, { method }), url: new URL(`https://app.adsbook.id${path}`), locals: { runtimeEnv: { PLATFORM_DB: platformDb } }, routePattern: "/", redirect: () => new Response(null, { status: 302 }) } as never, (async () => new Response("route")) as never);
      } finally {
        console.log = previous;
      }
    })() as Response;
    assert.equal(refused.status, 404, `${method} app.adsbook.id${path}`);
  }
  for (const [path, status] of [["/robots.txt", 200], ["/platform/login", 200], ["/platform/health", 302]] as const) {
    const response = (await run(`https://app.adsbook.id${path}`, "/")).response;
    assert.equal(response.status, status, `app.adsbook.id${path}`);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", `app.adsbook.id${path}`);
    if (status === 302) assert.equal(response.headers.get("location"), "/platform/login");
  }
  // The site: register, sign-in, console and APIs are noindex; the marketing pages are not.
  for (const path of ["/daftar", "/masuk", "/masuk/", "/platform", "/platform/login", "/platform/signup", "/platform/health", "/api/platform/masuk"]) {
    const response = (await run(`https://adsbook.id${path}`, "/")).response;
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", `adsbook.id${path} (${response.status})`);
  }
  for (const path of ["/", "/fitur", "/cara-kerja", "/harga", "/faq", "/kontak", "/syarat", "/privasi", "/llms.txt"]) {
    const response = (await run(`https://adsbook.id${path}`, "/")).response;
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-robots-tag"), null, `adsbook.id${path} stays indexable`);
  }
});

test("PLATFORM-SEO §2: robots.txt leaves /daftar and /masuk crawlable for every named agent; the console host disallows everything; the sitemap lists only indexable pages", async () => {
  const robots = await import("../pages/platform/site/robots.txt.ts");
  const sitemap = await import("../pages/platform/site/sitemap.xml.ts");
  const { ROBOTS_NAMED_AGENTS } = await import("../lib/robots.ts");
  const read = async (route: { GET: (context: never) => Response | Promise<Response> }, host: string) =>
    (await route.GET({ locals: { platform: { host }, runtimeEnv: { PLATFORM_SITE_URL: "https://adsbook.id" } } } as never)).text();
  const site = await read(robots, "adsbook.id");
  const groups = site.split("\n\n").filter((block) => block.startsWith("User-agent:"));
  assert.deepEqual(groups.map((block) => block.split("\n")[0].slice("User-agent: ".length)), ["*", ...ROBOTS_NAMED_AGENTS]);
  for (const block of groups) {
    assert.match(block, /^Disallow: \/platform\/$/m, block.split("\n")[0]);
    assert.match(block, /^Disallow: \/api\/$/m);
    assert.doesNotMatch(block, /Disallow: \/(daftar|masuk)/, "a noindex page stays crawlable so its noindex is read");
  }
  assert.match(site, /^Sitemap: https:\/\/adsbook\.id\/sitemap\.xml$/m);
  // Review P2-2: images and fonts under /platform/ stay readable by image and share crawlers.
  for (const block of groups) for (const ext of ["webp", "png", "svg", "woff2"]) assert.match(block, new RegExp(`^Allow: /platform/\\*\\.${ext}\\$$`, "m"));
  // The console host stays crawlable so its noindex headers are read; only its APIs are disallowed.
  assert.equal(await read(robots, "app.adsbook.id"), "User-agent: *\nDisallow: /api/\n");
  const urls = [...(await read(sitemap, "adsbook.id")).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]).pathname);
  assert.deepEqual(urls, ["/", "/fitur", "/cara-kerja", "/harga", "/faq", "/kontak", "/syarat", "/privasi"]);
});
