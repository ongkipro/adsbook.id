// T-34: two tenants through the real middleware and the real cron — each
// request and each hourly run reaches its own tenant's store and no other.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import { splitMigrationStatements } from "../lib/schema-version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { applyMigrationFile, readLedger, TenantStoreEngine, type MigrationFile, type StoreKv } from "./store-core.ts";
import type { TenantStoreStub } from "./tenant-db.ts";
import { createNodeStorage } from "./testing/node-storage.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const tenantDir = new URL("../db/migrations/", import.meta.url);
const CHAIN: MigrationFile[] = readdirSync(tenantDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, tenantDir), "utf8") }));
const platformDir = new URL("./migrations/", import.meta.url);
const PLATFORM_CHAIN: MigrationFile[] = readdirSync(platformDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, platformDir), "utf8") }));

// The Worker module imports Astro's handler, Vite's migration glob and the
// Durable Object base class; everything else is the production code.
const STUBS: Record<string, string> = {
  "astro:middleware": "export const defineMiddleware = (handler) => handler;",
  "@astrojs/cloudflare/handler": "export const handle = () => new Response('');",
  "cloudflare:workers": "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) return { url: `stub:${specifier}`, shortCircuit: true };
    if (/lib\/bundled-migrations(\.ts)?$/.test(specifier) || specifier === "./bundled-migrations.ts" && /src\/lib\//.test(context.parentURL ?? "")) {
      return { url: "stub:tenant-chain", shortCircuit: true };
    }
    if (specifier === "./bundled-migrations.ts" && /src\/platform\//.test(context.parentURL ?? "")) {
      return { url: "stub:platform-chain", shortCircuit: true };
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
    if (url === "stub:platform-chain") {
      return { format: "module", source: `export const PLATFORM_MIGRATIONS = ${JSON.stringify(PLATFORM_CHAIN)};`, shortCircuit: true };
    }
    if (url === "stub:tenant-chain") {
      return { format: "module", source: `export const BUNDLED_MIGRATIONS = ${JSON.stringify(CHAIN)};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { createMiddleware } = await import("../middleware.ts");
const { runPlatformCron } = await import("../worker.ts");
const { tenantDatabase } = await import("../lib/tenant-database.ts");
const orderStatusRoute = await import("../pages/api/order-status.ts");
const adminOrdersRoute = await import("../pages/api/admin/orders/index.ts");
const { resolveAuthSecret } = await import("../lib/auth-secret.ts");
const { signJwt, verifyJwt, SESSION_COOKIE_NAME } = await import("../lib/auth.ts");
const { storeAdminSession } = await import("../lib/admin-session.ts");
const { createTenantDb } = await import("./tenant-db.ts");
const { hashApiKeySecret } = await import("../lib/developer-api-keys.ts");
const headlessOpenApiRoute = await import("../pages/api/v1/openapi.json.ts");
const opsOpenApiRoute = await import("../pages/api/ops/v1/openapi.json.ts");
const { getProviderConfig, autoLarisOrderRailGap } = await import("../lib/provider-config.ts");
const { getStoreAdsConfig } = await import("../lib/store-ads.ts");
const { loadGoogleAdsOfflineConfig } = await import("../lib/google-ads-offline.ts");
// Not deregistered: both chains are imported lazily, on first use, so the stubs
// must still resolve then. node --test gives this file its own process.
void hooks;

function memoryKv(): StoreKv {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), put: (key, value) => void values.set(key, value), delete: (key) => void values.delete(key) };
}

/** A TENANT_STORE namespace: one engine-backed store per tenant id, created on first use. */
function namespace(options: { migrated?: boolean; failing?: string[] } = {}) {
  const stores = new Map<string, { storage: ReturnType<typeof createNodeStorage>; stub: TenantStoreStub }>();
  const asked: string[] = [];
  const get = (id: string) => {
    let store = stores.get(id);
    if (!store) {
      const storage = createNodeStorage();
      if (options.migrated) for (const file of CHAIN) applyMigrationFile(storage, file, splitMigrationStatements);
      const engine = new TenantStoreEngine(storage, memoryKv(), CHAIN, splitMigrationStatements);
      const hop = async <T>(run: () => T): Promise<T> => structuredClone(run());
      const stub: TenantStoreStub = {
        query: (protocol, statement, raw) => hop(() => (engine.checkProtocol(protocol), engine.query(statement, raw))),
        batch: (protocol, statements) => hop(() => (engine.checkProtocol(protocol), engine.batch(statements))),
        schemaState: (protocol) => hop(() => (engine.checkProtocol(protocol), engine.schemaState())),
        prepareMigration: (protocol) => hop(() => (engine.checkProtocol(protocol), { bookmark: `bm-${id}`, state: engine.schemaState() })),
        applyMigrations: (protocol, target, bookmarkId) => hop(() => (engine.checkProtocol(protocol), engine.applyMigrations(target, bookmarkId))),
      };
      store = { storage, stub };
      stores.set(id, store);
    }
    return store;
  };
  return {
    stores,
    asked,
    get,
    binding: {
      getByName(id: string, location: { locationHint?: string }) {
        asked.push(id);
        assert.equal(location?.locationHint, "apac-se");
        if (options.failing?.includes(id)) throw new Error("store unreachable");
        return get(id).stub;
      },
    },
  };
}

async function platform(rows: Array<[id: string, status: string, host: string]>) {
  const db = createSqliteD1();
  await ensureControlPlane(db, PLATFORM_CHAIN);
  for (const [id, status, host] of rows) {
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, ?, '2026-11-16')").run(id, id, `${id}@example.test`, status);
    db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, '2026-11-16')").run(host, id);
  }
  return db;
}

test("each tenant host reaches its own store, and the shared OMS_DB binding is never read", async () => {
  const platformDb = await platform([["t-a", "active", "toko-a.belanja.cc"], ["t-b", "active", "toko-b.belanja.cc"]]);
  const stores = namespace({ migrated: true });
  stores.get("t-a").storage.db.exec("INSERT INTO stores (id, name, slug, created_at, site_url) VALUES (1, 'Toko A', 'toko-a', '2026-11-16', 'https://toko-a.belanja.cc')");
  stores.get("t-b").storage.db.exec("INSERT INTO stores (id, name, slug, created_at, site_url) VALUES (1, 'Toko B', 'toko-b', '2026-11-16', 'https://toko-b.belanja.cc')");
  const sharedOmsDb = { prepare: () => { throw new Error("the shared OMS_DB binding was read"); } };
  const onRequest = createMiddleware();
  const previousLog = console.log;
  console.log = () => undefined;
  try {
    for (const [host, name] of [["toko-a.belanja.cc", "Toko A"], ["toko-b.belanja.cc", "Toko B"]]) {
      const href = `https://${host}/produk/x`;
      const locals: Record<string, unknown> = {
        runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, OMS_DB: sharedOmsDb },
      };
      const seen: Record<string, unknown> = {};
      const response = (await onRequest(
        {
          request: new Request(href),
          url: new URL(href),
          locals,
          routePattern: "/produk/[slug]",
          redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
        } as never,
        (async () => {
          const viaCapability = await tenantDatabase(locals as never)!.prepare("SELECT name FROM stores").first("name");
          Object.assign(seen, { viaCapability, identity: (locals.tenant as { name: string }).name });
          return new Response("ok");
        }) as never,
      )) as Response;
      assert.equal(response.status, 200, host);
      assert.deepEqual(seen, { viaCapability: name, identity: name }, host);
    }
  } finally {
    console.log = previousLog;
  }
  assert.deepEqual(stores.asked, ["t-a", "t-b"]);
});

// Tenant ids are never reused, so the per-isolate "ready" map is keyed by them;
// this test uses its own ids because the first test made t-a and t-b ready.
test("the platform cron runs each active tenant on its own store; a suspended one is skipped, a failing one isolated", async () => {
  const platformDb = await platform([
    ["c-a", "active", "cron-a.belanja.cc"],
    ["c-b", "active", "cron-b.belanja.cc"],
    ["c-c", "suspended", "cron-c.belanja.cc"],
    ["c-d", "active", "cron-d.belanja.cc"],
  ]);
  const stores = namespace({ failing: ["c-d"] });
  const sharedReads: string[] = [];
  const errors: string[] = [];
  const original = { error: console.error, info: console.info, warn: console.warn };
  console.error = (label: unknown, detail?: unknown) => void errors.push(`${String(label)} ${JSON.stringify(detail ?? null)}`);
  console.info = () => undefined;
  console.warn = () => undefined;
  let result: Awaited<ReturnType<typeof runPlatformCron>>;
  try {
    result = await runPlatformCron(
      // The shared OMS_DB binding must never be read: a tenant's maintenance uses its own store only.
      { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, OMS_DB: { prepare: (sql: string) => { sharedReads.push(sql); throw new Error("shared OMS_DB read"); } } } as never,
      Date.parse("2026-11-16T05:07:00.000Z"),
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(result, { tenants: 3, failed: ["c-d"] });
  assert.deepEqual(stores.asked, ["c-a", "c-b", "c-d"], "the suspended tenant is never opened");
  for (const id of ["c-a", "c-b"]) {
    const { storage } = stores.get(id);
    assert.equal(readLedger(storage).length, CHAIN.length, `${id} migrated before maintenance`);
    const heartbeat = storage.db.prepare("SELECT scheduler_ran_at FROM ops_health_snapshot").get() as { scheduler_ran_at: string } | undefined;
    assert.equal(heartbeat?.scheduler_ran_at, "2026-11-16T05:07:00.000Z", `${id} heartbeat`);
  }
  assert.ok(errors.some((line) => line.startsWith("scheduled-tenant-failed") && line.includes("c-d")));
  assert.deepEqual(sharedReads, [], "a maintenance step read the shared OMS_DB binding");
  assert.equal(
    (platformDb.sqlite.prepare("SELECT schema_version FROM tenants WHERE id = 'c-a'").get() as { schema_version: number }).schema_version,
    CHAIN.length,
  );
});

test("ISO-5: an order's status token answers on its own tenant's host only", async () => {
  const platformDb = await platform([["s-a", "active", "shop-a.belanja.cc"], ["s-b", "active", "shop-b.belanja.cc"]]);
  const stores = namespace({ migrated: true });
  for (const [id, number, token] of [["s-a", "INV-10001", "tok-a"], ["s-b", "INV-10001", "tok-b"]]) {
    stores.get(id).storage.db.exec(`
      INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16');
      INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
        total_amount, created_at, public_status_token)
      VALUES (1, '${number}', 1, 'Siti Rahayu', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, '2026-11-16T00:00:00.000Z', '${token}');
    `);
  }
  const onRequest = createMiddleware();
  const ask = async (host: string, token: string) => {
    const href = `https://${host}/api/order-status`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } };
    const request = new Request(href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: "INV-10001", status_token: token }) });
    const context = { request, url: new URL(href), locals, routePattern: "/api/order-status", redirect: () => new Response(null, { status: 302 }) };
    const previousLog = console.log;
    console.log = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => orderStatusRoute.POST(context as never)) as never)) as Response;
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } finally {
      console.log = previousLog;
    }
  };
  const own = await ask("shop-a.belanja.cc", "tok-a");
  assert.equal(own.status, 200);
  const crossed = await ask("shop-b.belanja.cc", "tok-a");
  assert.equal(crossed.status, 404, "tenant A's token must not open an order on tenant B's host");
  assert.equal(JSON.stringify(crossed.body).includes("tok-a"), false);
  assert.equal((await ask("shop-b.belanja.cc", "tok-b")).status, 200);
});

test("T-36: an admin session lists its own tenant's orders, and is refused on another tenant's host", async () => {
  const platformDb = await platform([["m-a", "active", "admin-a.belanja.cc"], ["m-b", "active", "admin-b.belanja.cc"]]);
  const stores = namespace({ migrated: true });
  for (const [id, number] of [["m-a", "INV-A0001"], ["m-b", "INV-B0001"]]) {
    stores.get(id).storage.db.exec(`
      INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16');
      UPDATE admin_credentials SET username = 'owner', password_hash = 'x', must_change_password = 0,
        updated_at = '2026-11-16T00:00:00.000Z', role = 'owner' WHERE id = 1;
      INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
        total_amount, created_at)
      VALUES (1, '${number}', 1, 'Siti Rahayu', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, '2026-11-16T00:00:00.000Z');
    `);
  }
  // A real session for tenant A: its own generated secret, its own session row.
  const aDb = createTenantDb(stores.get("m-a").stub);
  const secretA = await resolveAuthSecret(aDb, "m-a");
  const { token, session } = await signJwt({ username: "owner", role: "owner" }, secretA);
  await storeAdminSession(aDb, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });

  const onRequest = createMiddleware();
  const list = async (host: string) => {
    const href = `https://${host}/api/admin/orders`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } };
    const request = new Request(href, { headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` } });
    const context = { request, url: new URL(href), locals, routePattern: "/api/admin/orders", redirect: () => new Response(null, { status: 302 }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => adminOrdersRoute.GET(context as never)) as never)) as Response;
      return { status: response.status, text: await response.text() };
    } finally {
      Object.assign(console, previous);
    }
  };
  const own = await list("admin-a.belanja.cc");
  assert.equal(own.status, 200);
  assert.match(own.text, /INV-A0001/);
  assert.doesNotMatch(own.text, /INV-B0001/);
  const crossed = await list("admin-b.belanja.cc");
  assert.equal(crossed.status, 401, "tenant A's session must not open tenant B's admin");
  assert.doesNotMatch(crossed.text, /INV-[AB]0001/);
});

test("T-21: a tenant's admin token never verifies on another tenant, even with its session row copied there", async () => {
  const platformDb = await platform([["j-a", "active", "jwt-a.belanja.cc"], ["j-b", "active", "jwt-b.belanja.cc"]]);
  const stores = namespace({ migrated: true });
  for (const id of ["j-a", "j-b"]) {
    stores.get(id).storage.db.exec(`
      INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16');
      UPDATE admin_credentials SET username = 'owner', password_hash = 'x', must_change_password = 0,
        updated_at = '2026-11-16T00:00:00.000Z', role = 'owner' WHERE id = 1;
    `);
  }
  const aDb = createTenantDb(stores.get("j-a").stub);
  const bDb = createTenantDb(stores.get("j-b").stub);
  const secretA = await resolveAuthSecret(aDb, "j-a");
  const secretB = await resolveAuthSecret(bDb, "j-b");
  assert.ok(secretA.length >= 32 && secretB.length >= 32);
  assert.notEqual(secretA, secretB, "each tenant generates its own session key");

  const { token, session } = await signJwt({ username: "owner", role: "owner" }, secretA);
  assert.ok(await verifyJwt(token, secretA));
  assert.equal(await verifyJwt(token, secretB), null, "tenant A's token verifies under tenant B's key");

  // The strongest cross-tenant replay: the same session id is live in both stores.
  for (const database of [aDb, bDb]) {
    await storeAdminSession(database, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });
  }
  const onRequest = createMiddleware();
  const open = async (host: string) => {
    const href = `https://${host}/api/admin/orders`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, AUTH_SECRET: secretA } };
    const request = new Request(href, { headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` } });
    const context = { request, url: new URL(href), locals, routePattern: "/api/admin/orders", redirect: () => new Response(null, { status: 302 }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      return ((await onRequest(context as never, (async () => adminOrdersRoute.GET(context as never)) as never)) as Response).status;
    } finally {
      Object.assign(console, previous);
    }
  };
  assert.equal(await open("jwt-a.belanja.cc"), 200);
  // AUTH_SECRET in the env is tenant A's key: an env secret must not be honoured on any tenant.
  assert.equal(await open("jwt-b.belanja.cc"), 401, "tenant A's token opened tenant B's admin");
});

/** Every provider value a single-tenant install took from Worker env, set at once. */
const EVERY_PLATFORM_PROVIDER_ENV = {
  MENGANTAR_API_KEY: "env-mengantar", MENGANTAR_BASE_URL: "https://env.mengantar.test",
  MENGANTAR_ORIGIN_AREA_ID: "1", MENGANTAR_PICKUP_ADDRESS_ID: "2",
  AUTOLARIS_API_KEY: "env-autolaris", AUTOLARIS_BASE_URL: "https://env.autolaris.test",
  AUTOLARIS_ORDER_ORIGIN_ID: "1", AUTOLARIS_ORDER_DESTINATION_ID: "2", AUTOLARIS_SHIPPER_EMAIL: "ops@env.test",
  KELOLA_ORDER_WEBHOOK_URL: "https://env.kelola.test/api/public/toko/order/twh_env", KELOLA_ORDER_WEBHOOK_SECRET: "env",
  META_PIXEL_ID: "999999999999999", META_CAPI_ACCESS_TOKEN: "env-capi", FB_PIXEL_ID: "999999999999998",
  GTM_ID: "GTM-ENVONLY", GOOGLE_ADS_CONVERSION_ID: "AW-999999999", GOOGLE_ADS_CONVERSION_LABEL: "env-label",
  GOOGLE_ADS_CUSTOMER_ID: "1234567890", GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID: "987", GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "cid", GOOGLE_ADS_CLIENT_SECRET: "cs", GOOGLE_ADS_REFRESH_TOKEN: "rt",
  GOOGLE_ADS_OFFLINE_START_AT: "2026-01-01T00:00:00.000Z",
};

test("T-45/ISO-9: with every platform env value set, a tenant without settings is unconfigured and its cron calls no provider", async (context) => {
  const saved = new Map(Object.keys(EVERY_PLATFORM_PROVIDER_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, EVERY_PLATFORM_PROVIDER_ENV);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const platformDb = await platform([["p-a", "active", "plain-a.belanja.cc"]]);
  const stores = namespace({ migrated: true });
  // A paid order with a Google click and a delivered COD order: work any configured provider would pick up.
  stores.get("p-a").storage.db.exec(`
    INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko Polos', 'toko-polos', '2026-11-16');
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
      total_amount, created_at, payment_method, payment_status, shipping_status, ad_click_ids)
    VALUES (1, 'INV-P0001', 1, 'Siti Rahayu', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000,
      '2026-11-16T00:00:00.000Z', 'cod', 'unpaid', 'delivered', '{"gclid":"Cj0KCQ_valid-click"}');
  `);
  const database = createTenantDb(stores.get("p-a").stub);
  const locals = { tenantDb: database, runtimeEnv: { ...EVERY_PLATFORM_PROVIDER_ENV } } as never;

  const providers = await getProviderConfig(database, locals);
  assert.deepEqual(
    [providers.mengantar.apiKey, providers.mengantar.source, providers.autolaris.apiKey, providers.autolaris.source],
    ["", "none", "", "none"],
  );
  assert.equal(providers.mengantar.baseUrl.includes("env."), false);
  assert.equal(providers.autolaris.originId + providers.autolaris.destinationId + providers.autolaris.shipperEmail, "");
  assert.equal(
    autoLarisOrderRailGap({ ...providers.autolaris, warehouseAddress: "Jl. Gudang 1" }),
    "AutoLaris belum dikonfigurasi.",
  );
  const ads = await getStoreAdsConfig(locals);
  assert.deepEqual([ads.metaPixelId, ads.metaCapiToken, ads.googleTagManagerId, ads.googleAdsConversionId], ["", "", "", ""]);
  assert.equal(await loadGoogleAdsOfflineConfig(database), null);

  const original = { error: console.error, info: console.info, warn: console.warn, log: console.log };
  console.error = console.info = console.warn = console.log = () => undefined;
  try {
    const result = await runPlatformCron(
      { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...EVERY_PLATFORM_PROVIDER_ENV } as never,
      Date.parse("2026-11-16T05:07:00.000Z"),
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    assert.deepEqual(result, { tenants: 1, failed: [] });
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(calls, [], "a tenant without settings made an outbound provider call");
});

test("T-21: there is no installer page or route to answer /install", () => {
  const pages = new URL("../pages/", import.meta.url);
  for (const path of ["install.astro", "install/index.astro", "install.ts", "api/install.ts", "api/install/index.ts"]) {
    assert.throws(() => readFileSync(new URL(path, pages)), { code: "ENOENT" }, path);
  }
});

test("API-3 and ISO-4: each OpenAPI document names its own tenant's host, and a key works on its own tenant's host only", async () => {
  const platformDb = await platform([["k-a", "active", "key-a.belanja.cc"], ["k-b", "active", "key-b.belanja.cc"]]);
  const stores = namespace({ migrated: true });
  const secrets: Record<string, string> = { "k-a": "adsbook_live_tenant_a_key_000000000001", "k-b": "adsbook_live_tenant_b_key_000000000002" };
  for (const id of ["k-a", "k-b"]) {
    stores.get(id).storage.db
      .prepare(`INSERT INTO developer_api_keys (name, key_hash, key_preview, created_by, created_at, scopes)
        VALUES ('Storefront', ?, 'adsbook_live_…', 'owner', '2026-11-16', 'storefront:read,ops:orders:read')`)
      .run(await hashApiKeySecret(secrets[id]));
    stores.get(id).storage.db.exec(`INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16')`);
  }
  const onRequest = createMiddleware();
  const call = async (host: string, path: string, route: { GET: unknown }, key: string) => {
    const href = `https://${host}${path}`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } };
    const request = new Request(href, { headers: { "x-app-key": key } });
    const context = { request, url: new URL(href), locals, routePattern: path, redirect: () => new Response(null, { status: 302 }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => (route.GET as (c: unknown) => Promise<Response>)(context)) as never)) as Response;
      return { status: response.status, body: (await response.json()) as { servers?: Array<{ url: string }> } };
    } finally {
      Object.assign(console, previous);
    }
  };
  for (const [path, route, suffix] of [["/api/v1/openapi.json", headlessOpenApiRoute, "/api/v1"], ["/api/ops/v1/openapi.json", opsOpenApiRoute, "/api/ops/v1"]] as const) {
    for (const id of ["k-a", "k-b"]) {
      const host = id === "k-a" ? "key-a.belanja.cc" : "key-b.belanja.cc";
      const own = await call(host, path, route, secrets[id]);
      assert.equal(own.status, 200, `${path} on ${host}`);
      assert.equal(own.body.servers?.[0]?.url, `https://${host}${suffix}`);
    }
    const crossed = await call("key-b.belanja.cc", path, route, secrets["k-a"]);
    assert.equal(crossed.status, 401, `${path}: tenant A's key on tenant B's host`);
  }
});
