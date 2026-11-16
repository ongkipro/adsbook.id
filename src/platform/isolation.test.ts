// T-28 (PR-10, NFR-1): the cross-tenant isolation suite. ISO-3, AUTHZ-1 and
// AUTHZ-2 run here through the real middleware and admin routes; the last test
// holds the whole matrix (06-TENANT-ISOLATION §9, 07-IAM §11) to a named test
// each, so an ID can never lose its proof in silence.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import { splitMigrationStatements } from "../lib/schema-version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { applyMigrationFile, TenantStoreEngine, type MigrationFile, type StoreKv } from "./store-core.ts";
import type { TenantStoreStub } from "./tenant-db.ts";
import { createNodeStorage } from "./testing/node-storage.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const chain = (dir: URL): MigrationFile[] =>
  readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
const CHAIN = chain(new URL("../db/migrations/", import.meta.url));
const PLATFORM_CHAIN = chain(new URL("./migrations/", import.meta.url));

// Astro's middleware helper, the Cloudflare adapter and Vite's migration glob
// are the only stand-ins; everything else is the production code.
const STUBS: Record<string, string> = {
  "astro:middleware": "export const defineMiddleware = (handler) => handler;",
  "@astrojs/cloudflare/handler": "export const handle = () => new Response('');",
  "cloudflare:workers": "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) return { url: `stub:${specifier}`, shortCircuit: true };
    if (/bundled-migrations(\.ts)?$/.test(specifier)) {
      return { url: /src\/platform\//.test(context.parentURL ?? "") && specifier.startsWith("./") ? "stub:platform-chain" : "stub:tenant-chain", shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[a-z0-9]+$/i.test(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:") && url.slice(5) in STUBS) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    if (url === "stub:platform-chain") return { format: "module", source: `export const PLATFORM_MIGRATIONS = ${JSON.stringify(PLATFORM_CHAIN)};`, shortCircuit: true };
    if (url === "stub:tenant-chain") return { format: "module", source: `export const BUNDLED_MIGRATIONS = ${JSON.stringify(CHAIN)};`, shortCircuit: true };
    return nextLoad(url, context);
  },
});
void hooks;
const { createMiddleware } = await import("../middleware.ts");
const adminOrdersRoute = await import("../pages/api/admin/orders/index.ts");
const adminOrderRoute = await import("../pages/api/admin/orders/[id].ts");
const { resolveAuthSecret } = await import("../lib/auth-secret.ts");
const { signJwt, SESSION_COOKIE_NAME } = await import("../lib/auth.ts");
const { storeAdminSession } = await import("../lib/admin-session.ts");
const { createTenantDb } = await import("./tenant-db.ts");

function memoryKv(): StoreKv {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), put: (key, value) => void values.set(key, value), delete: (key) => void values.delete(key) };
}

/** Two tenants, each a migrated engine-backed store behind the TENANT_STORE binding. */
async function twoTenants() {
  const platformDb = createSqliteD1();
  await ensureControlPlane(platformDb, PLATFORM_CHAIN);
  const stores = new Map<string, TenantStoreStub>();
  const engines = new Map<string, ReturnType<typeof createNodeStorage>>();
  for (const [id, host, orderId, invoice] of [["iso-a", "iso-a.adsbook.my.id", 41, "INV-ISO-A"], ["iso-b", "iso-b.adsbook.my.id", 7, "INV-ISO-B"]] as const) {
    platformDb.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, 'active', '2026-11-16')").run(id, id, `${id}@example.test`);
    platformDb.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, '2026-11-16')").run(host, id);
    const storage = createNodeStorage();
    for (const file of CHAIN) applyMigrationFile(storage, file, splitMigrationStatements);
    storage.db.exec(`
      INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16');
      UPDATE admin_credentials SET username = 'owner', password_hash = 'x', must_change_password = 0, updated_at = '2026-11-16T00:00:00.000Z', role = 'owner' WHERE id = 1;
      INSERT INTO admin_credentials (id, username, password_hash, must_change_password, updated_at, role) VALUES (2, 'cs', 'x', 0, '2026-11-16T00:00:00.000Z', 'customer_service');
      INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, created_at)
        VALUES (${orderId}, '${invoice}', 1, 'Pembeli ${id}', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, '2026-11-16T00:00:00.000Z');
    `);
    const engine = new TenantStoreEngine(storage, memoryKv(), CHAIN, splitMigrationStatements);
    const hop = async <T>(run: () => T): Promise<T> => structuredClone(run());
    stores.set(id, {
      query: (protocol, statement, raw) => hop(() => (engine.checkProtocol(protocol), engine.query(statement, raw))),
      batch: (protocol, statements) => hop(() => (engine.checkProtocol(protocol), engine.batch(statements))),
      schemaState: (protocol) => hop(() => (engine.checkProtocol(protocol), engine.schemaState())),
    } as TenantStoreStub);
    engines.set(id, storage);
  }
  const binding = { getByName: (id: string) => stores.get(id)! };
  const session = async (id: string, username: string, role: string) => {
    const database = createTenantDb(stores.get(id)!);
    const { token, session } = await signJwt({ username, role: role as never }, await resolveAuthSecret(database, id));
    await storeAdminSession(database, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });
    return `${SESSION_COOKIE_NAME}=${token}`;
  };
  const onRequest = createMiddleware();
  const send = async (host: string, path: string, cookie: string, route?: (context: never) => Promise<Response> | Response, params: Record<string, string> = {}) => {
    const href = `https://${host}${path}`;
    const context = {
      request: new Request(href, { headers: { cookie } }),
      url: new URL(href),
      params,
      locals: { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: binding } },
      routePattern: path,
      redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
    };
    const quiet = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => (route ? route(context as never) : new Response("page"))) as never)) as Response;
      return { status: response.status, location: response.headers.get("location"), text: await response.text() };
    } finally {
      Object.assign(console, quiet);
    }
  };
  return { session, send };
}

test("ISO-3/AUTHZ-1: tenant A's owner session and A's order ids open nothing on tenant B's host", async () => {
  const { session, send } = await twoTenants();
  const ownerA = await session("iso-a", "owner", "owner");
  const ownerB = await session("iso-b", "owner", "owner");

  // The control: A's session works on A.
  const home = await send("iso-a.adsbook.my.id", "/api/admin/orders", ownerA, adminOrdersRoute.GET as never);
  assert.equal(home.status, 200);
  assert.match(home.text, /INV-ISO-A/);

  // A's session on B: the API refuses, the admin page sends it to B's login.
  const list = await send("iso-b.adsbook.my.id", "/api/admin/orders", ownerA, adminOrdersRoute.GET as never);
  assert.equal(list.status, 401);
  assert.doesNotMatch(list.text, /INV-ISO/);
  const detail = await send("iso-b.adsbook.my.id", "/api/admin/orders/41", ownerA, adminOrderRoute.GET as never, { id: "41" });
  assert.equal(detail.status, 401);
  assert.doesNotMatch(detail.text, /INV-ISO-A|Pembeli iso-a/);
  const page = await send("iso-b.adsbook.my.id", "/admin/orders", ownerA);
  assert.equal(page.status, 302);
  assert.equal(page.location, "/hello");

  // B's own owner asking B's host for A's order id finds nothing of A.
  const foreign = await send("iso-b.adsbook.my.id", "/api/admin/orders/41", ownerB, adminOrderRoute.GET as never, { id: "41" });
  assert.equal(foreign.status, 404);
  assert.doesNotMatch(foreign.text, /INV-ISO-A|Pembeli iso-a/);
  const own = await send("iso-b.adsbook.my.id", "/api/admin/orders/7", ownerB, adminOrderRoute.GET as never, { id: "7" });
  assert.equal(own.status, 200);
  assert.match(own.text, /INV-ISO-B/);
});

test("AUTHZ-2: customer service on its own store cannot open settings, by page or by API", async () => {
  const { session, send } = await twoTenants();
  const cs = await session("iso-a", "cs", "customer_service");
  const page = await send("iso-a.adsbook.my.id", "/admin/settings", cs);
  assert.equal(page.status, 302);
  assert.notEqual(page.location, "/admin/settings");
  const api = await send("iso-a.adsbook.my.id", "/api/admin/settings", cs, (() => new Response("settings")) as never);
  assert.equal(api.status, 403);
  assert.equal(JSON.parse(api.text).code, "PERMISSION_DENIED");
  // The control: the same session still reaches what its role allows.
  assert.equal((await send("iso-a.adsbook.my.id", "/api/admin/orders", cs, adminOrdersRoute.GET as never)).status, 200);
});

test("every isolation and authorization test ID names a test that exists (ISO-1…ISO-12, AUTHZ-1…AUTHZ-4)", () => {
  const root = new URL("../", import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
  const titles = walk(root)
    .filter((path) => path.endsWith(".test.ts"))
    .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/^test\(\s*(["'`])(.+?)\1/gm)].map((match) => match[2]));
  const ids = [...Array.from({ length: 12 }, (_, index) => `ISO-${index + 1}`), "AUTHZ-1", "AUTHZ-2", "AUTHZ-3", "AUTHZ-4"];
  const missing = ids.filter((id) => !titles.some((title) => new RegExp(`\\b${id}\\b`).test(title)));
  assert.deepEqual(missing, [], "each ID needs a test whose title names it");
});
