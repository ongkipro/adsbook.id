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
    ('toko-a.belanja.cc', 't-a', 'subdomain', 'active', 1, '2026-11-16'),
    ('toko-s.belanja.cc', 't-s', 'subdomain', 'active', 1, '2026-11-16'),
    ('toko-r.belanja.cc', 't-r', 'subdomain', 'active', 1, '2026-11-16');
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
      (async () => {
        nextCalls += 1;
        return nextImpl ? nextImpl() : new Response("route", { status: 200 });
      }) as never,
    )).catch((error: unknown) => error)) as Response | Error;
    return { response: response as Response, error: response instanceof Error ? response : null, touched, cacheReads, nextCalls, locals, logs: logs.map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    console.log = previousLog;
    (globalThis as { caches?: unknown }).caches = previousCaches;
  }
}

test("a refused host never reaches a cache, the tenant database or the route", async () => {
  for (const [href, status] of [
    ["https://nobody.belanja.cc/produk/x", 404],
    ["https://toko-s.belanja.cc/produk/x", 403],
    ["https://toko-r.belanja.cc/produk/x", 503],
    ["https://adsbook.id/produk/x", 404],
    ["https://toko-a.belanja.cc/platform/admin", 404],
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
  const result = await run("https://toko-a.belanja.cc/api/webhooks/autolaris/secret-token-123?phone=6281234567890", "/api/webhooks/autolaris");
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(
    { id: (result.locals.tenantContext as { tenantId: string }).tenantId, primary: (result.locals.tenantContext as { primaryHost: string }).primaryHost },
    { id: "t-a", primary: "toko-a.belanja.cc" },
  );
  assert.equal(result.locals.platform, undefined);
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].tenant_id, "t-a");
  assert.equal(result.logs[0].host_kind, "tenant");
  assert.equal(result.logs[0].route, "/api/webhooks/autolaris");
  assert.doesNotMatch(JSON.stringify(result.logs[0]), /secret-token-123|6281234567890/);
});

test("a platform route on a platform host runs with platform context and no tenant work", async () => {
  const result = await run("https://adsbook.id/platform/health", "/platform/health");
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.locals.platform, { host: "adsbook.id" });
  assert.equal(result.locals.tenantContext, undefined);
  assert.deepEqual(result.touched, []);
  assert.deepEqual(result.cacheReads, []);
  assert.equal(result.logs[0].host_kind, "platform");
  assert.equal(result.logs[0].tenant_id, null);
});

test("exactly one log line on every path: a gate refusal with its reason, and a route that throws", async () => {
  const down = await run("https://toko-a.belanja.cc/produk/x", "/produk/[slug]", undefined, { PLATFORM_DB: undefined });
  assert.equal(down.response.status, 503);
  assert.equal(down.logs.length, 1);
  assert.equal(down.logs[0].reason, "platform_db_unbound");

  const thrown = await run("https://adsbook.id/platform/x", "/platform/x", async () => {
    throw new Error("route failed");
  });
  assert.equal(thrown.error?.message, "route failed");
  assert.equal(thrown.logs.length, 1);
  assert.deepEqual({ status: thrown.logs[0].status, reason: thrown.logs[0].reason, host_kind: thrown.logs[0].host_kind }, { status: 500, reason: "unhandled_exception", host_kind: "platform" });
});
