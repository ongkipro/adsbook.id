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
import { TEST_CREDENTIAL_ENV } from "./testing/credentials.ts";
import { bindCredentials, STORE_CREDENTIAL_COLUMNS } from "../lib/credential-crypto.ts";

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
const { runPlatformCron, CRON_MIGRATION_BATCH, CRON_ARM_BATCH } = await import("./cron.ts");
const workerModule = await import("../worker.ts");
const { runTenantMaintenance } = await import("./tenant-maintenance.ts");
const { readTenantRow, runTenantAlarm, TENANT_ALARM_INTERVAL_MS } = await import("./tenant-alarm.ts");
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
const { maskSecretValue } = await import("../lib/env.ts");
const { loadGoogleAdsOfflineConfig } = await import("../lib/google-ads-offline.ts");
const autolarisWebhookRoute = await import("../pages/api/webhooks/autolaris/[token].ts");
const { issueWebhookToken } = await import("./webhook-secrets.ts");
const { probeAnswer } = await import("./hostnames.ts");
const { signup, TERMS_VERSION } = await import("./signup.ts");
const { runPurges, requestStoreRemoval, cancelStoreRemoval, PURGE_DRAIN_MS, POST_PURGE_SWEEP_BATCH } = await import("./purge.ts");
const { issueHandoff, prepareHandoffRequest, HANDOFF_ORIGIN_HEADER } = await import("./handoff.ts");
const { RESERVED_SLUGS, SELLER_ZONE_RECORDS } = await import("./slugs.ts");
const { runPlatformJobs } = await import("./jobs.ts");
const handoffRoute = await import("../pages/api/handoff.ts");
const { totpCode, base32Encode, newTotpSecret } = await import("./admin/totp.ts");
const { platformLogin, PLATFORM_COOKIE_NAME } = await import("./admin/session.ts");
const { runTenantAction } = await import("./admin/tenants.ts");
const { platformHealth } = await import("./admin/health.ts");
const { redeemOwnerRecovery } = await import("./admin/recovery.ts");
const { recordTenantHealth } = await import("./tenant-alarm.ts");
const platformTenantsRoute = await import("../pages/api/platform/tenants/index.ts");
const platformActionRoute = await import("../pages/api/platform/tenants/[id]/[action].ts");
const { hashAdminPassword } = await import("../lib/admin-credentials.ts");
const { getAdminCredential, verifyAdminLoginPassword, validateAdminUsername } = await import("../lib/admin-credentials.ts");
const { buildSetupChecklist, readSetupFacts } = await import("../lib/setup-checklist.ts");
const { readReadiness, isStoreReady } = await import("./readiness.ts");
const { legalText, readStoreProviders, storePrivacyMarkdown } = await import("./legal.ts");
const { recordUsage } = await import("./plans.ts");
const submitOrderRoute = await import("../pages/api/submit-order.ts");
const platformSignupRoute = await import("../pages/api/platform/signup.ts");
const adminSettingsRoute = await import("../pages/api/admin/settings.ts");
const adminAdsRoute = await import("../pages/api/admin/ads.ts");
const kelolaAdminRoute = await import("../pages/api/admin/plugins/kelola.ts");
// Not deregistered: both chains are imported lazily, on first use, so the stubs
// must still resolve then. node --test gives this file its own process.
void hooks;

function memoryKv(): StoreKv {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), put: (key, value) => void values.set(key, value), delete: (key) => void values.delete(key) };
}

/** A TENANT_STORE namespace: one engine-backed store per tenant id, created on first use. */
function namespace(options: { migrated?: boolean; failing?: string[] } = {}) {
  const stores = new Map<string, { storage: ReturnType<typeof createNodeStorage>; stub: TenantStoreStub; engine: TenantStoreEngine }>();
  const asked: string[] = [];
  /** The one pending alarm per store (DO semantics), by tenant id. */
  const alarms = new Map<string, number>();
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
        // T-26: deleteAll + deleteAlarm — the next use starts an empty store.
        purge: (protocol: number, tenantId: string) =>
          hop(() => {
            engine.checkProtocol(protocol);
            stores.delete(tenantId);
            alarms.delete(tenantId);
          }),
        armAlarm: (protocol: number, tenantId: string) =>
          hop(() => {
            engine.checkProtocol(protocol);
            if (alarms.has(tenantId)) return { armed: false };
            alarms.set(tenantId, 0);
            return { armed: true };
          }),
      } as TenantStoreStub;
      store = { storage, stub, engine };
      stores.set(id, store);
    }
    return store;
  };
  return {
    stores,
    asked,
    alarms,
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

/**
 * One alarm invocation of `TenantStore.alarm()` (T-24), with its own
 * subrequest budget: every outbound fetch in it counts against `budget` only.
 */
async function fireAlarm(
  stores: ReturnType<typeof namespace>,
  platformDb: D1Database,
  id: string,
  env: Record<string, unknown>,
  now: number,
) {
  const { stub, engine } = stores.get(id);
  return runTenantAlarm({
    tenantId: id,
    now,
    schemaState: () => engine.schemaState(),
    readTenant: (tenantId) => readTenantRow(platformDb, tenantId),
    maintain: (tenantId, time, primaryHost) =>
      // Bound as TenantStore.alarm binds it (ADR-040).
      runTenantMaintenance({ PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV, ...env } as never,
        bindCredentials(createTenantDb(stub), tenantId, { ...TEST_CREDENTIAL_ENV, ...env }), tenantId, time,
        { waitUntil() {}, passThroughOnException() {} } as never, primaryHost),
    setAlarm: async (at) => void stores.alarms.set(id, at),
  });
}

/** T-38: give a store row what the PR-23 ready predicate needs, so buyer routes answer. */
function makeReady(sql: { exec(source: string): void }) {
  sql.exec(`
    UPDATE stores SET mengantar_api_key = 'mengantar-test-key';
    INSERT INTO products (id, store_id, title, slug, is_active, created_at) VALUES (900, 1, 'Siap', 'siap-900', 1, '2026-11-16');
    INSERT INTO product_variants (product_id, sku, title, price, weight_grams) VALUES (900, 'SIAP-900', 'Siap', 10000, 100);
    INSERT INTO warehouses (store_id, name, origin_area_id, pickup_address_id, address, city, province, is_primary, is_active)
      VALUES (1, 'Utama', '12345', 'pickup-1', 'Jl. Siap 1', 'Bandung', 'Jawa Barat', 1, 1);
    INSERT INTO courier_rules (store_id, courier_code, is_enabled) SELECT 1, 'jne', 1 WHERE NOT EXISTS (SELECT 1 FROM courier_rules WHERE is_enabled = 1);
  `);
}

async function platform(rows: Array<[id: string, status: string, host: string]>) {
  const db = createSqliteD1();
  await ensureControlPlane(db, PLATFORM_CHAIN);
  for (const [id, status, host] of rows) {
    // Subscribed (ADR-041), so buyer routes answer; Preview Mode has its own tests.
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, subscription_ends_at, grace_ends_at, created_at) VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', '2099-01-03T00:00:00.000Z', '2026-11-16')").run(id, id, `${id}@example.test`, status);
    db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, '2026-11-16')").run(host, id);
  }
  return db;
}

test("each tenant host reaches its own store, and the shared OMS_DB binding is never read", async () => {
  const platformDb = await platform([["t-a", "active", "toko-a.adsbook.my.id"], ["t-b", "active", "toko-b.adsbook.my.id"]]);
  const stores = namespace({ migrated: true });
  stores.get("t-a").storage.db.exec("INSERT INTO stores (id, name, slug, created_at, site_url) VALUES (1, 'Toko A', 'toko-a', '2026-11-16', 'https://toko-a.adsbook.my.id')");
  stores.get("t-b").storage.db.exec("INSERT INTO stores (id, name, slug, created_at, site_url) VALUES (1, 'Toko B', 'toko-b', '2026-11-16', 'https://toko-b.adsbook.my.id')");
  makeReady(stores.get("t-a").storage.db);
  makeReady(stores.get("t-b").storage.db);
  const sharedOmsDb = { prepare: () => { throw new Error("the shared OMS_DB binding was read"); } };
  const onRequest = createMiddleware();
  const previousLog = console.log;
  console.log = () => undefined;
  try {
    for (const [host, name] of [["toko-a.adsbook.my.id", "Toko A"], ["toko-b.adsbook.my.id", "Toko B"]]) {
      const href = `https://${host}/produk/x`;
      const locals: Record<string, unknown> = {
        runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV, OMS_DB: sharedOmsDb },
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
test("T-24: the cron migrates quiet tenants (bookmark first), arms each active tenant's alarm, isolates a failing one", async () => {
  const platformDb = await platform([
    ["c-a", "active", "cron-a.adsbook.my.id"],
    ["c-b", "active", "cron-b.adsbook.my.id"],
    ["c-c", "suspended", "cron-c.adsbook.my.id"],
    ["c-d", "active", "cron-d.adsbook.my.id"],
  ]);
  const stores = namespace({ failing: ["c-d"] });
  const errors: string[] = [];
  const original = { error: console.error, info: console.info, warn: console.warn };
  console.error = (label: unknown, detail?: unknown) => void errors.push(`${String(label)} ${JSON.stringify(detail ?? null)}`);
  console.info = () => undefined;
  console.warn = () => undefined;
  let result: Awaited<ReturnType<typeof runPlatformCron>>;
  try {
    result = await runPlatformCron(
      { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } as never,
      Date.parse("2026-11-16T05:07:00.000Z"),
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(result, { migrated: ["c-a", "c-b"], armed: 2, failed: ["c-d"] });
  assert.equal(stores.asked.includes("c-c"), false, "the suspended tenant is never opened");
  assert.deepEqual([...stores.alarms.keys()].sort(), ["c-a", "c-b"]);
  for (const id of ["c-a", "c-b"]) {
    assert.equal(readLedger(stores.get(id).storage).length, CHAIN.length, `${id} migrated without a request`);
    const bookmark = platformDb.sqlite.prepare("SELECT bookmark FROM migration_bookmarks WHERE tenant_id = ?").get(id) as { bookmark: string } | undefined;
    assert.equal(bookmark?.bookmark, `bm-${id}`, `${id}: bookmark stored before migrating (MIG-1)`);
    assert.equal(
      (platformDb.sqlite.prepare("SELECT schema_version FROM tenants WHERE id = ?").get(id) as { schema_version: number }).schema_version,
      CHAIN.length,
    );
  }
  assert.ok(errors.some((line) => line.startsWith("scheduled-tenant-migration-failed") && line.includes("c-d")));
  // The cron runs no tenant's maintenance itself: no heartbeat until an alarm fires.
  assert.equal(stores.get("c-a").storage.db.prepare("SELECT scheduler_ran_at FROM ops_health_snapshot").get(), undefined);
  assert.ok(CRON_MIGRATION_BATCH >= 1);
});

test("T-24: a fleet larger than one arming batch is swept over the hours, each run bounded", async () => {
  const ids = Array.from({ length: CRON_ARM_BATCH * 2 + 50 }, (_, index) => `f-${String(index).padStart(4, "0")}`);
  const platformDb = await platform(ids.map((id) => [id, "active", `${id}.adsbook.my.id`] as [string, string, string]));
  platformDb.sqlite.prepare("UPDATE tenants SET schema_version = ?").run(CHAIN.length);
  const stores = namespace();
  const original = { error: console.error, info: console.info };
  console.error = console.info = () => undefined;
  const armedPerRun: number[] = [];
  try {
    for (let hour = 0; hour < 3; hour += 1) {
      const before = stores.asked.length;
      const result = await runPlatformCron(
        { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } as never,
        Date.parse("2026-11-16T00:07:00.000Z") + hour * 3_600_000,
        { waitUntil() {}, passThroughOnException() {} } as never,
      );
      assert.ok(stores.asked.length - before <= CRON_ARM_BATCH, "one run touched more stores than its batch");
      armedPerRun.push(result.armed);
    }
  } finally {
    Object.assign(console, original);
  }
  assert.equal(stores.alarms.size, ids.length, "every tenant armed after a full rotation");
  assert.deepEqual(armedPerRun.slice().sort((a, b) => a - b), [50, CRON_ARM_BATCH, CRON_ARM_BATCH]);
});

test("T-24/ISO-10: 50 alarms, one failing and one making 900 calls: 49 heartbeats, one logged failure, no budget error", async (context) => {
  const ids = Array.from({ length: 50 }, (_, index) => `h-${String(index).padStart(2, "0")}`);
  const platformDb = await platform(ids.map((id) => [id, "active", `${id}.adsbook.my.id`] as [string, string, string]));
  const stores = namespace({ migrated: true });
  for (const id of ids) stores.get(id).storage.db.exec(`INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16')`);
  const FAILING = "h-07";
  const NOISY = "h-23";
  // The failing tenant's store throws on every query (ISO-10: B throws, A runs).
  stores.get(FAILING).engine.query = () => { throw new Error("store broken"); };

  let budget = { limit: 1000, used: 0 };
  const budgetErrors: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    budget.used += 1;
    if (budget.used > budget.limit) {
      budgetErrors.push("Too many subrequests");
      throw new Error("Too many subrequests");
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  const errors: string[] = [];
  const original = { error: console.error, info: console.info, warn: console.warn, log: console.log };
  console.error = (label: unknown, detail?: unknown) => void errors.push(`${String(label)} ${JSON.stringify(detail ?? null)}`);
  console.info = console.warn = console.log = () => undefined;
  const now = Date.parse("2026-11-16T06:00:00.000Z");
  const outcomes: Record<string, string> = {};
  try {
    for (const id of ids) {
      budget = { limit: 1000, used: 0 }; // each alarm is its own invocation
      if (id === NOISY) {
        for (let call = 0; call < 900; call += 1) await fetch("https://provider.test/");
      }
      outcomes[id] = await fireAlarm(stores, platformDb as never, id, {}, now);
    }
  } finally {
    Object.assign(console, original);
  }
  const heartbeats = ids.filter((id) => {
    if (id === FAILING) return false;
    const row = stores.get(id).storage.db.prepare("SELECT scheduler_ran_at FROM ops_health_snapshot").get() as { scheduler_ran_at: string } | undefined;
    return row?.scheduler_ran_at === "2026-11-16T06:00:00.000Z";
  });
  assert.equal(heartbeats.length, 49);
  assert.deepEqual(budgetErrors, [], "a tenant's run hit another's subrequest budget");
  assert.ok(errors.some((line) => line.includes(FAILING)), "the failing tenant is logged with its id");
  assert.ok(errors.every((line) => !line.includes("tenant_id") || line.includes(FAILING)), `another tenant logged a failure: ${errors.join(" | ")}`);
  // Every alarm re-armed for the next hour, the failing one included.
  assert.ok(ids.every((id) => stores.alarms.get(id) === now + TENANT_ALARM_INTERVAL_MS));
  assert.equal(Object.values(outcomes).filter((outcome) => outcome === "ran").length, 49);
});

test("T-24/MIG-1: an alarm behind the bundled chain does no maintenance, re-arms and logs; an inactive tenant does nothing", async () => {
  const platformDb = await platform([["m-1", "active", "mig-1.adsbook.my.id"], ["m-2", "suspended", "mig-2.adsbook.my.id"]]);
  const stores = namespace(); // not migrated: applied 0 < bundled
  const errors: string[] = [];
  const original = { error: console.error, info: console.info };
  console.error = (label: unknown, detail?: unknown) => void errors.push(`${String(label)} ${JSON.stringify(detail ?? null)}`);
  console.info = () => undefined;
  const now = Date.parse("2026-11-16T07:00:00.000Z");
  try {
    assert.equal(await fireAlarm(stores, platformDb as never, "m-1", {}, now), "schema_behind");
    assert.equal(await fireAlarm(stores, platformDb as never, "m-2", {}, now), "inactive");
  } finally {
    Object.assign(console, original);
  }
  assert.equal(readLedger(stores.get("m-1").storage).length, 0, "the alarm never migrates");
  assert.equal(stores.alarms.get("m-1"), now + TENANT_ALARM_INTERVAL_MS, "re-armed");
  assert.equal(stores.alarms.has("m-2"), false, "an inactive tenant is not re-armed");
  assert.ok(errors.some((line) => line.startsWith("tenant-alarm-schema-behind") && line.includes("m-1")));
});

test("ISO-5: an order's status token answers on its own tenant's host only", async () => {
  const platformDb = await platform([["s-a", "active", "shop-a.adsbook.my.id"], ["s-b", "active", "shop-b.adsbook.my.id"]]);
  const stores = namespace({ migrated: true });
  for (const [id, number, token] of [["s-a", "INV-10001", "tok-a"], ["s-b", "INV-10001", "tok-b"]]) {
    stores.get(id).storage.db.exec(`
      INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16');
      INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
        total_amount, created_at, public_status_token)
      VALUES (1, '${number}', 1, 'Siti Rahayu', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, '2026-11-16T00:00:00.000Z', '${token}');
    `);
    makeReady(stores.get(id).storage.db);
  }
  const onRequest = createMiddleware();
  const ask = async (host: string, token: string) => {
    const href = `https://${host}/api/order-status`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } };
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
  const own = await ask("shop-a.adsbook.my.id", "tok-a");
  assert.equal(own.status, 200);
  const crossed = await ask("shop-b.adsbook.my.id", "tok-a");
  assert.equal(crossed.status, 404, "tenant A's token must not open an order on tenant B's host");
  assert.equal(JSON.stringify(crossed.body).includes("tok-a"), false);
  assert.equal((await ask("shop-b.adsbook.my.id", "tok-b")).status, 200);
});

test("T-36: an admin session lists its own tenant's orders, and is refused on another tenant's host", async () => {
  const platformDb = await platform([["m-a", "active", "admin-a.adsbook.my.id"], ["m-b", "active", "admin-b.adsbook.my.id"]]);
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
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } };
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
  const own = await list("admin-a.adsbook.my.id");
  assert.equal(own.status, 200);
  assert.match(own.text, /INV-A0001/);
  assert.doesNotMatch(own.text, /INV-B0001/);
  const crossed = await list("admin-b.adsbook.my.id");
  assert.equal(crossed.status, 401, "tenant A's session must not open tenant B's admin");
  assert.doesNotMatch(crossed.text, /INV-[AB]0001/);
});

test("T-21: a tenant's admin token never verifies on another tenant, even with its session row copied there", async () => {
  const platformDb = await platform([["j-a", "active", "jwt-a.adsbook.my.id"], ["j-b", "active", "jwt-b.adsbook.my.id"]]);
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
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV, AUTH_SECRET: secretA } };
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
  assert.equal(await open("jwt-a.adsbook.my.id"), 200);
  // AUTH_SECRET in the env is tenant A's key: an env secret must not be honoured on any tenant.
  assert.equal(await open("jwt-b.adsbook.my.id"), 401, "tenant A's token opened tenant B's admin");
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

  const platformDb = await platform([["p-a", "active", "plain-a.adsbook.my.id"]]);
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
  // No env area pair is read: an unconfigured store gets the default pair, never a platform value.
  assert.deepEqual([providers.autolaris.originId, providers.autolaris.destinationId, providers.autolaris.customArea, providers.autolaris.shipperEmail], ["3517100", "3518010", false, ""]);
  assert.equal(autoLarisOrderRailGap({ apiKey: providers.autolaris.apiKey }), "AutoLaris belum dikonfigurasi.");
  const ads = await getStoreAdsConfig(locals);
  assert.deepEqual([ads.metaPixelId, ads.metaCapiToken, ads.googleTagManagerId, ads.googleAdsConversionId], ["", "", "", ""]);
  assert.equal(await loadGoogleAdsOfflineConfig(database), null);

  const original = { error: console.error, info: console.info, warn: console.warn, log: console.log };
  console.error = console.info = console.warn = console.log = () => undefined;
  try {
    const result = await runPlatformCron(
      { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV, ...EVERY_PLATFORM_PROVIDER_ENV } as never,
      Date.parse("2026-11-16T05:07:00.000Z"),
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    assert.deepEqual(result, { migrated: ["p-a"], armed: 1, failed: [] });
    assert.equal(await fireAlarm(stores, platformDb as never, "p-a", { ...EVERY_PLATFORM_PROVIDER_ENV }, Date.parse("2026-11-16T05:07:00.000Z")), "ran");
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(calls, [], "a tenant without settings made an outbound provider call");
});

test("T-22/ISO-11: a cookie set from tenant A's host for the parent domain never stands in for a session on tenant B", async () => {
  const platformDb = await platform([["x-a", "active", "fix-a.adsbook.my.id"], ["x-b", "active", "fix-b.adsbook.my.id"]]);
  const stores = namespace({ migrated: true });
  const tokens: Record<string, string> = {};
  for (const id of ["x-a", "x-b"]) {
    stores.get(id).storage.db.exec(`
      INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16');
      UPDATE admin_credentials SET username = 'owner', password_hash = 'x', must_change_password = 0,
        updated_at = '2026-11-16T00:00:00.000Z', role = 'owner' WHERE id = 1;
      INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
        total_amount, created_at)
      VALUES (1, 'INV-${id.toUpperCase()}', 1, 'Siti Rahayu', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, '2026-11-16T00:00:00.000Z');
    `);
    const database = createTenantDb(stores.get(id).stub);
    const { token, session } = await signJwt({ username: "owner", role: "owner" }, await resolveAuthSecret(database, id));
    await storeAdminSession(database, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });
    tokens[id] = token;
  }
  const onRequest = createMiddleware();
  const send = async (host: string, init: { method?: string; cookie?: string; headers?: Record<string, string> }) => {
    const href = `https://${host}/api/admin/orders`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } };
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    const request = new Request(href, { method: init.method ?? "GET", headers });
    const context = { request, url: new URL(href), locals, routePattern: "/api/admin/orders", redirect: () => new Response(null, { status: 302 }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => adminOrdersRoute.GET(context as never)) as never)) as Response;
      return { status: response.status, text: await response.text(), csp: response.headers.get("content-security-policy") };
    } finally {
      Object.assign(console, previous);
    }
  };

  // What a script on A can plant for `.adsbook.my.id`: any name but a `__Host-` one.
  const planted = `adsbook_session=${tokens["x-a"]}; __host-adsbook_session=${tokens["x-a"]}`;
  assert.equal((await send("fix-b.adsbook.my.id", { cookie: planted })).status, 401, "a planted parent-domain cookie opened B");
  const intact = await send("fix-b.adsbook.my.id", { cookie: `${planted}; ${SESSION_COOKIE_NAME}=${tokens["x-b"]}` });
  assert.equal(intact.status, 200, "B's own session survives the planted cookies");
  assert.match(intact.text, /INV-X-B/);
  assert.doesNotMatch(intact.text, /INV-X-A/);
  // SEC-3: the admin answer carries the admin policy and no seller tag host.
  assert.equal(intact.csp, "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  assert.doesNotMatch(intact.csp ?? "", /googletagmanager|facebook|tiktok|doubleclick/);

  // IAM-5 on an unsafe admin route, with B's valid session in every case.
  const bCookie = `${SESSION_COOKIE_NAME}=${tokens["x-b"]}`;
  const post = (headers: Record<string, string>) => send("fix-b.adsbook.my.id", { method: "POST", cookie: bCookie, headers });
  const sameSiteCrossHost = await post({ origin: "https://fix-a.adsbook.my.id", "sec-fetch-site": "same-site" });
  assert.equal(sameSiteCrossHost.status, 403, "a same-site cross-host POST was accepted");
  assert.equal(JSON.parse(sameSiteCrossHost.text).code, "forbidden_origin");
  assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 403, "a POST without Origin was accepted");
  const oldBrowser = await post({ origin: "https://fix-b.adsbook.my.id" });
  assert.equal(oldBrowser.status, 403);
  assert.deepEqual(JSON.parse(oldBrowser.text), {
    success: false,
    error: "Browser ini terlalu lama untuk menyimpan perubahan dengan aman. Perbarui browser Anda, lalu coba lagi.",
    code: "browser_unsupported",
  });
  const sameOrigin = await post({ origin: "https://fix-b.adsbook.my.id", "sec-fetch-site": "same-origin" });
  assert.notEqual(sameOrigin.status, 403, "a same-origin POST from a current browser was refused");

  // IAM-5 covers admin pages too, not only /api/admin (T-22 review).
  const pageHref = "https://fix-b.adsbook.my.id/admin/profile";
  const pageRequest = new Request(pageHref, { method: "POST", headers: { cookie: bCookie, "sec-fetch-site": "same-site", origin: "https://fix-a.adsbook.my.id" } });
  const pageContext = { request: pageRequest, url: new URL(pageHref), locals: { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } }, routePattern: "/admin/profile", redirect: () => new Response(null, { status: 302 }) };
  const previousLog = console.log;
  console.log = () => undefined;
  try {
    const pageResponse = (await onRequest(pageContext as never, (async () => new Response("handled")) as never)) as Response;
    assert.equal(pageResponse.status, 403, "a cross-host POST to an admin page reached its handler");
  } finally {
    console.log = previousLog;
  }
});

test("T-23/API-7: a webhook writes only on its tenant's subdomain with that tenant's token", async () => {
  const platformDb = await platform([["w-a", "active", "hook-a.adsbook.my.id"], ["w-b", "active", "hook-b.adsbook.my.id"]]);
  platformDb.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES ('shop-a.example', 'w-a', 'custom', 'active', 0, '2026-11-16')").run();
  const stores = namespace({ migrated: true });
  for (const id of ["w-a", "w-b"]) {
    stores.get(id).storage.db.exec(`INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16')`);
    makeReady(stores.get(id).storage.db);
  }
  const tokenA = await issueWebhookToken(platformDb, "w-a", "autolaris");
  const tokenB = await issueWebhookToken(platformDb, "w-b", "autolaris");
  const onRequest = createMiddleware();
  const call = async (host: string, token: string) => {
    const href = `https://${host}/api/webhooks/autolaris/${token}`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } };
    const request = new Request(href, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ data: { reff_id: "10041", trx_id: "TRX-1", status: "PAID" } }),
    });
    const context = { request, url: new URL(href), params: { token }, locals, routePattern: "/api/webhooks/autolaris/[token]", redirect: () => new Response(null, { status: 302 }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      return ((await onRequest(context as never, (async () => autolarisWebhookRoute.POST(context as never)) as never)) as Response).status;
    } finally {
      Object.assign(console, previous);
    }
  };
  const evidence = (id: string) =>
    (stores.get(id).storage.db.prepare("SELECT COUNT(*) AS n FROM autolaris_callbacks").get() as { n: number }).n;
  const writes = () => [evidence("w-a"), evidence("w-b")];
  // Every row any statement changed in either store or the control plane, not only evidence rows.
  const changes = () =>
    ["w-a", "w-b"].map((id) => (stores.get(id).storage.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n)
      .concat((platformDb.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  const before = changes();

  assert.equal(await call("hook-a.adsbook.my.id", "0".repeat(64)), 401, "a wrong token");
  assert.equal(await call("hook-a.adsbook.my.id", "not-a-token"), 401, "a malformed token");
  assert.equal(await call("hook-a.adsbook.my.id", tokenB), 401, "tenant B's token on tenant A's host");
  assert.equal(await call("shop-a.example", tokenA), 404, "A's own token on A's custom domain");
  assert.deepEqual(writes(), [0, 0], "a refused webhook wrote evidence");
  assert.deepEqual(changes(), before, "a refused webhook changed a row (rate limit, store or control plane)");

  assert.equal(await call("hook-a.adsbook.my.id", tokenA), 200);
  assert.deepEqual(writes(), [1, 0], "the accepted call recorded for its own tenant only");

  // A rotated token stops the old one at once.
  const rotated = await issueWebhookToken(platformDb, "w-a", "autolaris");
  assert.equal(await call("hook-a.adsbook.my.id", tokenA), 401);
  assert.equal(await call("hook-a.adsbook.my.id", rotated), 200);
  assert.deepEqual(writes(), [2, 0]);
});

test("T-25: a custom primary moves indexing off the subdomain; the probe answers the tenant; a pending host never reaches tenant code", async () => {
  const platformDb = await platform([["d-a", "active", "dom-a.adsbook.my.id"]]);
  platformDb.sqlite.exec(`
    UPDATE tenant_hosts SET is_primary = 0 WHERE host = 'dom-a.adsbook.my.id';
    INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at)
      VALUES ('tokoa.com', 'd-a', 'custom', 'tokoa.com', 'active', 1, '2026-11-16'),
             ('baru.com', 'd-a', 'custom', 'baru.com', 'pending', 0, '2026-11-16');
  `);
  const stores = namespace({ migrated: true });
  stores.get("d-a").storage.db.exec("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko A', 'toko-a', '2026-11-16')");
  makeReady(stores.get("d-a").storage.db);
  const onRequest = createMiddleware();
  const visit = async (host: string, path = "/") => {
    const href = `https://${host}${path}`;
    let reached = false;
    let siteUrl = "";
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } };
    const context = { request: new Request(href), url: new URL(href), locals, routePattern: path, redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => {
        reached = true;
        siteUrl = (locals.tenant as { siteUrl: string }).siteUrl;
        return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
      }) as never)) as Response;
      return { status: response.status, location: response.headers.get("location"), robots: response.headers.get("x-robots-tag"), text: await response.text(), reached, siteUrl };
    } finally {
      Object.assign(console, previous);
    }
  };
  // Paduka 2026-11-16: buyer pages on the subdomain move to the custom primary for good.
  const sub = await visit("dom-a.adsbook.my.id");
  assert.equal(sub.status, 301);
  assert.equal(sub.location, "https://tokoa.com/");
  // The owner's way in stays on the subdomain, unindexed, with canonical URLs on the primary.
  const signIn = await visit("dom-a.adsbook.my.id", "/hello");
  assert.equal(signIn.reached, true);
  assert.equal(signIn.robots, "noindex, nofollow", "the subdomain never competes with the custom primary");
  assert.equal(signIn.siteUrl, "https://tokoa.com", "canonical URLs follow the primary host");
  const custom = await visit("tokoa.com");
  assert.equal(custom.robots, null);
  const nonce = "a".repeat(32);
  const probe = await visit("tokoa.com", `/.well-known/adsbook-probe?n=${nonce}`);
  const secret = await resolveAuthSecret(createTenantDb(stores.get("d-a").stub), "d-a");
  assert.equal(probe.text, await probeAnswer(secret, "tokoa.com", nonce), "the proof is the tenant's own HMAC");
  assert.equal(probe.reached, false, "the probe is answered before any page");
  assert.equal((await visit("tokoa.com", "/.well-known/adsbook-probe")).status, 404, "no nonce, no proof");
  const pending = await visit("baru.com");
  assert.equal(pending.status, 404);
  assert.equal(pending.reached, false, "a pending custom host reached tenant code");
});

test("T-21: there is no installer page or route to answer /install", () => {
  const pages = new URL("../pages/", import.meta.url);
  for (const path of ["install.astro", "install/index.astro", "install.ts", "api/install.ts", "api/install/index.ts"]) {
    assert.throws(() => readFileSync(new URL(path, pages)), { code: "ENOENT" }, path);
  }
});

test("API-3 and ISO-4: each OpenAPI document names its own tenant's host, and a key works on its own tenant's host only", async () => {
  const platformDb = await platform([["k-a", "active", "key-a.adsbook.my.id"], ["k-b", "active", "key-b.adsbook.my.id"]]);
  const stores = namespace({ migrated: true });
  const secrets: Record<string, string> = { "k-a": "adsbook_live_tenant_a_key_000000000001", "k-b": "adsbook_live_tenant_b_key_000000000002" };
  for (const id of ["k-a", "k-b"]) {
    stores.get(id).storage.db
      .prepare(`INSERT INTO developer_api_keys (name, key_hash, key_preview, created_by, created_at, scopes)
        VALUES ('Storefront', ?, 'adsbook_live_…', 'owner', '2026-11-16', 'storefront:read,ops:orders:read')`)
      .run(await hashApiKeySecret(secrets[id]));
    stores.get(id).storage.db.exec(`INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16')`);
    makeReady(stores.get(id).storage.db);
  }
  const onRequest = createMiddleware();
  const call = async (host: string, path: string, route: { GET: unknown }, key: string) => {
    const href = `https://${host}${path}`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } };
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
      const host = id === "k-a" ? "key-a.adsbook.my.id" : "key-b.adsbook.my.id";
      const own = await call(host, path, route, secrets[id]);
      assert.equal(own.status, 200, `${path} on ${host}`);
      assert.equal(own.body.servers?.[0]?.url, `https://${host}${suffix}`);
    }
    const crossed = await call("key-b.adsbook.my.id", path, route, secrets["k-a"]);
    assert.equal(crossed.status, 401, `${path}: tenant A's key on tenant B's host`);
  }
});

// ---------------------------------------------------------------- T-26 ----

/** A signup harness: one control plane, one store namespace, Turnstile passing. */
async function signupHarness() {
  const platformDb = await platform([]);
  const stores = namespace();
  const env = { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } as Record<string, unknown>;
  const input = (slug: string, email = `owner@${slug}.example`) => ({
    storeName: `Toko ${slug}`,
    slug,
    email,
    password: "kata-sandi-panjang-1",
    terms: true,
    turnstileToken: "ok",
  });
  let ip = 0;
  const run = (slug: string, deps: Parameters<typeof signup>[3] = {}, email?: string) =>
    signup(env, input(slug, email), `203.0.113.${(ip += 1) % 250}`, { verifyTurnstile: async () => true, ...deps });
  const tenant = (slug: string) =>
    platformDb.sqlite.prepare("SELECT id, status FROM tenants WHERE slug = ?").get(slug) as { id: string; status: string } | undefined;
  return { platformDb, stores, env, run, tenant, input };
}

test("T-26/IAM-10: a signup yields an active tenant whose owner signs in with the email; admin/admin never does", async () => {
  const { platformDb, stores, run } = await signupHarness();
  const result = await run("toko-baru");
  assert.equal(result.status, 201);
  if (result.status !== 201) return;
  assert.equal(result.host, "toko-baru.adsbook.my.id");
  const row = platformDb.sqlite.prepare("SELECT status, schema_version FROM tenants WHERE id = ?").get(result.tenantId) as { status: string; schema_version: number };
  assert.deepEqual({ ...row }, { status: "active", schema_version: CHAIN.length });
  const host = platformDb.sqlite.prepare("SELECT status, is_primary, kind FROM tenant_hosts WHERE host = 'toko-baru.adsbook.my.id'").get() as object;
  assert.deepEqual({ ...host }, { status: "active", is_primary: 1, kind: "subdomain" });
  const event = platformDb.sqlite.prepare("SELECT detail_json FROM tenant_events WHERE tenant_id = ? AND kind = 'signup'").get(result.tenantId) as { detail_json: string };
  assert.equal(JSON.parse(event.detail_json).terms_version, TERMS_VERSION);
  assert.ok(platformDb.sqlite.prepare("SELECT 1 FROM webhook_secrets WHERE tenant_id = ?").get(result.tenantId));

  const database = createTenantDb(stores.get(result.tenantId).stub);
  const owner = await getAdminCredential(database, "owner@toko-baru.example");
  assert.ok(owner);
  assert.equal(owner.role, "owner");
  assert.equal(owner.mustChangePassword, false);
  assert.equal(await verifyAdminLoginPassword("kata-sandi-panjang-1", owner), true, "the owner signs in with the signup password");
  const seeded = await getAdminCredential(database, "admin");
  assert.equal(seeded, null, "no default `admin` row remains");
  assert.equal(validateAdminUsername("cs.siti"), true, "staff usernames still work");
  assert.equal(validateAdminUsername("owner@toko-baru.example"), true);
  assert.equal(validateAdminUsername("bukan email@x"), false);
});

test("T-26/API-4: invalid input 400, taken or reserved slug 409, rate limited 429, the password never the email", async () => {
  const { run, env, input } = await signupHarness();
  assert.equal((await run("sudah-ada")).status, 201);
  assert.equal((await run("sudah-ada")).status, 409, "a taken slug");
  for (const reserved of ["cname", "fallback", "www", "admin", "api"]) {
    assert.equal((await run(reserved)).status, 409, reserved);
  }
  assert.equal((await run("x")).status, 400, "too short");
  const same = await signup(env, { ...input("sama-email"), password: "owner@sama-email.example" }, "198.51.100.1", { verifyTurnstile: async () => true });
  assert.equal(same.status, 400);
  const robot = await signup(env, input("robot"), "198.51.100.2", { verifyTurnstile: async () => false });
  assert.equal(robot.status, 400);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    statuses.push((await signup(env, input(`banjir-${attempt}`), "198.51.100.9", { verifyTurnstile: async () => true })).status);
  }
  assert.equal(statuses.at(-1), 429, "the sixth signup from one address in an hour");
});

test("T-26: the reserved list holds every non-wildcard record of the seller zone", () => {
  for (const record of SELLER_ZONE_RECORDS.filter((name) => name !== "@" && name !== "*")) {
    assert.ok(RESERVED_SLUGS.has(record), record);
  }
  assert.ok(RESERVED_SLUGS.has("www"));
  assert.equal(RESERVED_SLUGS.has("demo"), false, "the demo seed signs up normally");
});

test("T-26: a failure at each provisioning step leaves no active tenant, its host answers 404, and the purge frees the slug", async () => {
  for (const step of ["reserve", "store", "install", "secrets"] as const) {
    const { platformDb, stores, env, run, tenant } = await signupHarness();
    const original = { error: console.error, log: console.log, info: console.info };
    console.error = console.log = console.info = () => undefined;
    try {
      const failed = await run(`gagal-${step}`, { checkpoint: (at) => { if (at === step) throw new Error(`injected at ${step}`); } });
      assert.equal(failed.status, 500, step);
      assert.equal(tenant(`gagal-${step}`)?.status, "purging", step);
      const event = platformDb.sqlite.prepare("SELECT detail_json FROM tenant_events WHERE kind = 'provision_failed'").get() as { detail_json: string };
      assert.equal(JSON.parse(event.detail_json).step, step);

      // The host never routes.
      const href = `https://gagal-${step}.adsbook.my.id/hello`;
      let reached = false;
      const onRequest = createMiddleware();
      const response = (await onRequest(
        { request: new Request(href), url: new URL(href), locals: { runtimeEnv: env }, routePattern: "/hello", redirect: () => new Response(null, { status: 302 }) } as never,
        (async () => { reached = true; return new Response("ok"); }) as never,
      )) as Response;
      assert.equal(response.status, 404, step);
      assert.equal(reached, false, step);

      // The purge removes it entirely (it was never active), and the slug is free again.
      const fenced = await runPurges(env, new Date());
      assert.deepEqual(fenced.completed, [], `${step}: the first run only fences`);
      const purged = await runPurges(env, new Date(Date.now() + PURGE_DRAIN_MS + 1000));
      assert.equal(purged.completed.length, 1, step);
      assert.equal(tenant(`gagal-${step}`), undefined, step);
      assert.equal([...stores.stores.keys()].some((id) => id.startsWith("t_")), false, `${step}: a store survived`);
      assert.equal((await run(`gagal-${step}`)).status, 201, `${step}: coba lagi`);
    } finally {
      Object.assign(console, original);
    }
  }
});

test("T-26/IAM-10: a provisioning whose claim updates no seeded row ends in purging, never active", async () => {
  const { stores, run, tenant } = await signupHarness();
  const original = { error: console.error };
  console.error = () => undefined;
  try {
    const result = await run("tanpa-kursi", {
      checkpoint: (step, tenantId) => {
        if (step === "store") stores.get(tenantId).storage.db.exec("UPDATE admin_credentials SET must_change_password = 0");
      },
    });
    assert.equal(result.status, 500);
  } finally {
    Object.assign(console, original);
  }
  assert.equal(tenant("tanpa-kursi")?.status, "purging");
});

test("T-26: a provisioning row older than 15 minutes is moved to purging and purged", async () => {
  const { platformDb, env, tenant } = await signupHarness();
  platformDb.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t_mati', 'mati-tengah', 'x@y.example', 'provisioning', ?)").run(new Date(Date.now() - 16 * 60_000).toISOString());
  platformDb.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t_baru', 'baru-mulai', 'x@z.example', 'provisioning', ?)").run(new Date(Date.now() - 60_000).toISOString());
  const result = await runPurges(env, new Date());
  assert.equal(result.staleProvisioning, 1);
  assert.equal(tenant("mati-tengah")?.status, "purging");
  assert.equal(tenant("baru-mulai")?.status, "provisioning", "a young provisioning row is left alone");
  await runPurges(env, new Date(Date.now() + PURGE_DRAIN_MS + 1000));
  assert.equal(tenant("mati-tengah"), undefined);
});

test("T-26/IAM-8: a handoff redeems once on its own host and purpose; replay, expiry, wrong host or purpose, foreign origin are refused; the token is never logged", async () => {
  const { platformDb, stores, env, run } = await signupHarness();
  const a = await run("serah-a");
  const b = await run("serah-b");
  assert.ok(a.status === 201 && b.status === 201);
  if (a.status !== 201 || b.status !== 201) return;
  const onRequest = createMiddleware();
  const logged: string[] = [];
  const redeem = async (host: string, token: string, headers: Record<string, string> = { origin: "https://app.adsbook.id", "sec-fetch-site": "cross-site" }) => {
    const href = `https://${host}/api/handoff`;
    const body = new URLSearchParams({ token });
    // Through the Worker entry's preparation, as in production.
    const request = prepareHandoffRequest(new Request(href, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body }));
    const cookies = new Map<string, { value: string; options: Record<string, unknown> }>();
    const context = {
      request,
      url: new URL(href),
      locals: { runtimeEnv: env },
      routePattern: "/api/handoff",
      cookies: { set: (name: string, value: string, options: Record<string, unknown>) => cookies.set(name, { value, options }) },
      redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
    };
    const previous = { log: console.log, error: console.error };
    console.log = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void logged.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(" "));
    try {
      const response = (await onRequest(context as never, (async () => handoffRoute.POST(context as never)) as never)) as Response;
      return { status: response.status, location: response.headers.get("location"), cookie: cookies.get("__Host-adsbook_session") };
    } finally {
      Object.assign(console, previous);
    }
  };

  assert.equal((await redeem("serah-b.adsbook.my.id", a.handoffToken)).status, 401, "A's token on B's host");
  assert.equal((await redeem("serah-a.adsbook.my.id", a.handoffToken, { origin: "https://serah-b.adsbook.my.id", "sec-fetch-site": "same-site" })).status, 401, "posted from another seller host");
  assert.equal((await redeem("serah-a.adsbook.my.id", a.handoffToken, { "sec-fetch-site": "cross-site" })).status, 401, "no Origin");
  const first = await redeem("serah-a.adsbook.my.id", a.handoffToken);
  assert.equal(first.status, 303);
  assert.equal(first.location, "/admin/dashboard");
  assert.ok(first.cookie?.value);
  assert.equal(first.cookie?.options.secure, true);
  assert.equal(first.cookie?.options.path, "/");
  assert.equal("domain" in (first.cookie?.options ?? {}), false);
  assert.equal((await redeem("serah-a.adsbook.my.id", a.handoffToken)).status, 401, "replay");

  const recovery = await issueHandoff(platformDb, a.tenantId, "serah-a.adsbook.my.id", "owner_recovery");
  assert.equal((await redeem("serah-a.adsbook.my.id", recovery)).status, 401, "wrong purpose");
  const expired = await issueHandoff(platformDb, a.tenantId, "serah-a.adsbook.my.id", "signup", new Date(Date.now() - 11 * 60_000));
  assert.equal((await redeem("serah-a.adsbook.my.id", expired)).status, 401, "expired");

  for (const token of [a.handoffToken, b.handoffToken, recovery, expired]) {
    assert.equal(logged.some((line) => line.includes(token)), false, "a handoff token reached a log line");
  }
  // The session works: it verifies under A's own key only.
  const secretA = await resolveAuthSecret(createTenantDb(stores.get(a.tenantId).stub), a.tenantId);
  assert.ok(await verifyJwt(first.cookie!.value, secretA));
});

test("T-26/PRIV-4: removal is requested for 30 days, cancellable, then the purge leaves nothing of the tenant", async () => {
  const { platformDb, stores, env, run, tenant } = await signupHarness();
  const gone = await run("pergi");
  const stays = await run("tinggal");
  assert.ok(gone.status === 201 && stays.status === 201);
  if (gone.status !== 201 || stays.status !== 201) return;
  // Shared resources of both tenants.
  const objects = new Map<string, string>();
  const kv = new Map<string, string>();
  env.ASSET_BUCKET = {
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit);
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
    delete: async (keys: string[]) => void keys.forEach((key) => objects.delete(key)),
  };
  env.SESSION = {
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...kv.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    delete: async (key: string) => void kv.delete(key),
  };
  for (const id of [gone.tenantId, stays.tenantId]) {
    objects.set(`t/${id}/uploads/2026-11-16/a.webp`, "x");
    kv.set(`t:${id}:store-config:x`, "y");
  }
  platformDb.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at, cf_custom_hostname_id) VALUES ('pergi.example', ?, 'custom', 'pergi.example', 'active', 0, '2026-11-16', 'cf-pergi')").run(gone.tenantId);

  const now = new Date();
  const purgeAfter = await requestStoreRemoval(platformDb, gone.tenantId, "owner", now);
  assert.ok(purgeAfter);
  assert.equal(Date.parse(purgeAfter!) - now.getTime(), 30 * 24 * 60 * 60 * 1000);
  assert.equal(await cancelStoreRemoval(platformDb, gone.tenantId, "owner", now), true, "cancellable");
  assert.ok(await requestStoreRemoval(platformDb, gone.tenantId, "owner", now));

  // A day early nothing happens; after the date the job starts the purge and the purge finishes it.
  await runPlatformJobs(platformDb, new Date(now.getTime() + 29 * 24 * 3_600_000));
  assert.equal(tenant("pergi")?.status, "active");
  await runPlatformJobs(platformDb, new Date(now.getTime() + 31 * 24 * 3_600_000));
  assert.equal(tenant("pergi")?.status, "purging");
  const deleted: string[] = [];
  const day31 = now.getTime() + 31 * 24 * 3_600_000;
  const fenceRun = await runPurges(env, new Date(day31), { deleteCustomHostname: async (ref) => void deleted.push(ref) });
  assert.deepEqual(fenceRun.completed, [], "the first run fences and waits for in-flight writers");
  assert.equal(platformDb.sqlite.prepare("SELECT 1 FROM tenant_hosts WHERE tenant_id = ? AND status != 'revoked'").get(gone.tenantId), undefined, "fenced: no host routes");
  // A write admitted before the fence lands during the drain window; the sweep still catches it.
  objects.set(`t/${gone.tenantId}/uploads/2026-11-16/late.webp`, "late");
  const result = await runPurges(env, new Date(day31 + PURGE_DRAIN_MS + 1000), { deleteCustomHostname: async (ref) => void deleted.push(ref) });
  assert.deepEqual(result.completed, [gone.tenantId]);
  assert.equal(tenant("pergi")?.status, "purged", "an active tenant ends as a tombstone");
  assert.deepEqual(deleted, ["cf-pergi"]);
  assert.equal([...objects.keys()].some((key) => key.includes(gone.tenantId)), false, "an R2 object survived");
  assert.equal([...kv.keys()].some((key) => key.includes(gone.tenantId)), false, "a KV key survived");
  assert.equal(stores.stores.has(gone.tenantId), false, "the store survived");
  for (const table of ["webhook_secrets", "handoff_tokens", "migration_bookmarks"]) {
    assert.equal(platformDb.sqlite.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ?`).get(gone.tenantId), undefined, table);
  }
  assert.equal(platformDb.sqlite.prepare("SELECT 1 FROM tenant_hosts WHERE tenant_id = ? AND status != 'revoked'").get(gone.tenantId), undefined);
  // The other tenant is untouched.
  assert.equal(tenant("tinggal")?.status, "active");
  assert.ok(objects.has(`t/${stays.tenantId}/uploads/2026-11-16/a.webp`));
  assert.ok(kv.has(`t:${stays.tenantId}:store-config:x`));
  assert.ok(stores.stores.has(stays.tenantId));
  // Idempotent: a second purge run of a purged tenant does nothing harmful.
  assert.deepEqual((await runPurges(env, new Date())).completed, []);
  // A request that outlived the drain writes after completion: the post-purge sweep removes it.
  objects.set(`t/${gone.tenantId}/uploads/2026-11-16/very-late.webp`, "x");
  kv.set(`t:${gone.tenantId}:late`, "y");
  await runPurges(env, new Date(day31 + 2 * 24 * 3_600_000));
  assert.equal([...objects.keys()].some((key) => key.includes(gone.tenantId)), false, "a late object survived the sweep");
  assert.equal([...kv.keys()].some((key) => key.includes(gone.tenantId)), false, "a late key survived the sweep");
  assert.ok(objects.has(`t/${stays.tenantId}/uploads/2026-11-16/a.webp`), "the sweep touched another tenant");
});

test("T-26 review: a handoff failure fails the signup; losing the activation race leaves a never-active tenant", async () => {
  const original = { error: console.error, log: console.log, info: console.info };
  console.error = console.log = console.info = () => undefined;
  try {
    for (const step of ["handoff", "activate"] as const) {
      const { platformDb, env, run, tenant } = await signupHarness();
      const failed = await run(`akhir-${step}`, { checkpoint: (at) => { if (at === step) throw new Error(`injected at ${step}`); } });
      assert.equal(failed.status, 500, step);
      assert.equal(tenant(`akhir-${step}`)?.status, "purging", step);
      await runPurges(env, new Date());
      await runPurges(env, new Date(Date.now() + PURGE_DRAIN_MS + 1000));
      // `activate` failed after its commit: the tenant was active once, so it is a tombstone.
      assert.equal(tenant(`akhir-${step}`)?.status, step === "activate" ? "purged" : undefined, step);
      assert.ok(platformDb);
    }
    // The stale-provisioning job takes the row just before activation.
    const { platformDb, run, tenant } = await signupHarness();
    const raced = await run("kalah-balap", {
      checkpoint: (at, tenantId) => {
        if (at === "handoff") platformDb.sqlite.prepare("UPDATE tenants SET status = 'purging' WHERE id = ?").run(tenantId);
      },
    });
    assert.equal(raced.status, 500);
    const id = tenant("kalah-balap")!.id;
    assert.equal(platformDb.sqlite.prepare("SELECT 1 FROM tenant_events WHERE tenant_id = ? AND kind = 'signup'").get(id), undefined, "no signup event for a tenant never activated");
    assert.equal(platformDb.sqlite.prepare("SELECT status FROM tenant_hosts WHERE tenant_id = ?").get(id) && (platformDb.sqlite.prepare("SELECT status FROM tenant_hosts WHERE tenant_id = ?").get(id) as { status: string }).status, "pending");
  } finally {
    Object.assign(console, original);
  }
});

test("T-26 review: the handoff origin is an exact platform origin; local relaxations stay on *.localhost", async () => {
  const { isPlatformHandoffOrigin } = await import("./handoff.ts");
  const hosts = new Set(["adsbook.id", "app.adsbook.id", "app.localhost"]);
  assert.equal(isPlatformHandoffOrigin("https://app.adsbook.id", "cross-site", hosts), true);
  assert.equal(isPlatformHandoffOrigin("https://app.adsbook.id:8443", "cross-site", hosts), false, "a port");
  assert.equal(isPlatformHandoffOrigin("http://app.adsbook.id", "cross-site", hosts), false, "plain http");
  assert.equal(isPlatformHandoffOrigin("https://app.adsbook.id", "same-site", hosts), false);
  assert.equal(isPlatformHandoffOrigin("https://evil.example", "cross-site", hosts), false);
  assert.equal(isPlatformHandoffOrigin(null, "cross-site", hosts), false);
  assert.equal(isPlatformHandoffOrigin("http://app.localhost:8787", "same-site", hosts), true, "local dev");
  assert.equal(isPlatformHandoffOrigin("http://toko.localhost:8787", "same-site", hosts), false, "another seller host");
});

test("T-26 review: purges that keep waiting do not starve the others (hourly rotation)", async () => {
  const { platformDb, env } = await signupHarness();
  const at = new Date(Date.now() - 60 * 60_000).toISOString();
  for (let index = 0; index < 8; index += 1) {
    platformDb.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, 'x@y.example', 'purging', ?)").run(`t_putar${index}`, `putar-${index}`, at);
    // Each holds a custom hostname Cloudflare refuses to delete.
    platformDb.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at, cf_custom_hostname_id) VALUES (?, ?, 'custom', 'revoked', 0, ?, 'cf-x')").run(`putar-${index}.example`, `t_putar${index}`, at);
  }
  const touched = new Set<string>();
  const original = console.error;
  console.error = () => undefined;
  try {
    const base = Date.parse("2026-11-16T00:30:00.000Z");
    for (let hour = 0; hour < 4; hour += 1) {
      const result = await runPurges(env, new Date(base + hour * 3_600_000), { deleteCustomHostname: async () => { throw new Error("Cloudflare down"); } });
      [...result.pending, ...result.completed].forEach((id) => touched.add(id));
    }
  } finally {
    console.error = original;
  }
  assert.equal(touched.size, 8, "a tenant was never reached");
});

test("T-26 review: the post-purge sweep reaches every recently completed tenant, with completions still arriving", async () => {
  const { platformDb, env } = await signupHarness();
  const objects = new Map<string, string>();
  env.ASSET_BUCKET = {
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => ({
      objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit).map((key) => ({ key })),
      truncated: false,
    }),
    delete: async (keys: string[]) => void keys.forEach((key) => objects.delete(key)),
  };
  const base = Date.parse("2026-11-16T00:30:00.000Z");
  const complete = (id: string, at: number) => {
    platformDb.sqlite.prepare("INSERT INTO purge_sweeps (tenant_id, completed_at) VALUES (?, ?)").run(id, new Date(at).toISOString());
    objects.set(`t/${id}/late.webp`, "x");
  };
  const total = POST_PURGE_SWEEP_BATCH * 2 + 10;
  for (let index = 0; index < total; index += 1) complete(`t_z${String(index).padStart(4, "0")}`, base - 3_600_000 + index);
  for (let hour = 0; hour < 4; hour += 1) {
    // New completions with low ids keep arriving.
    complete(`t_a${hour}`, base + hour * 3_600_000 - 1000);
    await runPurges(env, new Date(base + hour * 3_600_000));
  }
  const left = [...objects.keys()].filter((key) => key.startsWith("t/t_z"));
  assert.deepEqual(left, [], `${left.length} completed tenants were never swept`);
});

test("T-26 review: at the documented ceiling (25 completions an hour, rolling expiry) every tenant is swept before its window ends", async () => {
  const { platformDb, env } = await signupHarness();
  const swept = new Set<string>();
  env.ASSET_BUCKET = {
    list: async ({ prefix }: { prefix: string }) => {
      swept.add(prefix.slice(2, -1));
      return { objects: [], truncated: false };
    },
    delete: async () => undefined,
  };
  const base = Date.parse("2026-11-16T00:30:00.000Z");
  const insert = platformDb.sqlite.prepare("INSERT INTO purge_sweeps (tenant_id, completed_at) VALUES (?, ?)");
  const hours = 200;
  for (let hour = 0; hour < hours; hour += 1) {
    for (let index = 0; index < POST_PURGE_SWEEP_BATCH / 2; index += 1) {
      insert.run(`t_h${hour}x${index}`, new Date(base + hour * 3_600_000 - 1000).toISOString());
    }
    await runPurges(env, new Date(base + hour * 3_600_000));
  }
  const missed: string[] = [];
  for (let hour = 0; hour < hours; hour += 1) {
    for (let index = 0; index < POST_PURGE_SWEEP_BATCH / 2; index += 1) {
      if (!swept.has(`t_h${hour}x${index}`)) missed.push(`t_h${hour}x${index}`);
    }
  }
  assert.deepEqual(missed.slice(0, 5), [], `${missed.length} tenants were never swept`);
});

test("T-26 review: under sustained arrivals a late write after the first sweep is still removed; failing sweeps rotate", async () => {
  const { platformDb, env } = await signupHarness();
  const objects = new Map<string, string>();
  const failing = new Set<string>();
  env.ASSET_BUCKET = {
    list: async ({ prefix }: { prefix: string }) => {
      const id = prefix.slice(2, -1);
      if (failing.has(id)) throw new Error("R2 down for this tenant");
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
    delete: async (keys: string[]) => void keys.forEach((key) => objects.delete(key)),
  };
  const base = Date.parse("2026-11-16T00:30:00.000Z");
  const insert = platformDb.sqlite.prepare("INSERT INTO purge_sweeps (tenant_id, completed_at) VALUES (?, ?)");
  const original = console.error;
  console.error = () => undefined;
  try {
    // 50 tenants whose sweep always fails, then one healthy tenant.
    for (let index = 0; index < POST_PURGE_SWEEP_BATCH; index += 1) {
      failing.add(`t_bad${index}`);
      insert.run(`t_bad${index}`, new Date(base - 10_000 + index).toISOString());
    }
    insert.run("t_good", new Date(base - 1).toISOString());
    objects.set("t/t_good/x.webp", "x");
    let hour = 0;
    const tick = async () => {
      for (let index = 0; index < 20; index += 1) insert.run(`t_new${hour}x${index}`, new Date(base + hour * 3_600_000 - 500).toISOString());
      await runPurges(env, new Date(base + hour * 3_600_000));
      hour += 1;
    };
    for (let run = 0; run < 3; run += 1) await tick();
    assert.equal(objects.has("t/t_good/x.webp"), false, "the healthy tenant was starved by failing ones");
    // A late write after its first sweep, while 20 new completions arrive every hour.
    objects.set("t/t_good/late.webp", "x");
    for (let run = 0; run < 6; run += 1) await tick();
    assert.equal(objects.has("t/t_good/late.webp"), false, "a late write after the first sweep survived");
  } finally {
    console.error = original;
  }
});

test("T-26 review: a completion that queued past its window is still swept before it leaves", async () => {
  const { platformDb, env } = await signupHarness();
  const swept: string[] = [];
  env.ASSET_BUCKET = {
    list: async ({ prefix }: { prefix: string }) => (swept.push(prefix.slice(2, -1)), { objects: [], truncated: false }),
    delete: async () => undefined,
  };
  platformDb.sqlite.prepare("INSERT INTO purge_sweeps (tenant_id, completed_at) VALUES ('t_tua', ?)").run(new Date(Date.now() - 8 * 24 * 3_600_000).toISOString());
  await runPurges(env, new Date());
  assert.ok(swept.includes("t_tua"), "an expired but never-swept completion was dropped");
  await runPurges(env, new Date());
  assert.equal(platformDb.sqlite.prepare("SELECT 1 FROM purge_sweeps WHERE tenant_id = 't_tua'").get(), undefined, "swept and expired rows leave");
});

test("the Worker entry module exports only its handler and the Durable Object class", () => {
  // workerd treats every export as an entrypoint and refuses the script when
  // one is neither a handler nor a class (caught on local workerd, T-26).
  assert.deepEqual(Object.keys(workerModule).sort(), ["TenantStore", "default"]);
});

test("T-26: the handoff's real Origin is carried past Astro only on its own path, and a client copy is dropped", () => {
  const forged = prepareHandoffRequest(new Request("https://toko.adsbook.my.id/api/handoff", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      [HANDOFF_ORIGIN_HEADER]: "https://app.adsbook.id",
      "x-adsbook-handoff-fetch-site": "cross-site",
    },
  }));
  assert.equal(forged.headers.get(HANDOFF_ORIGIN_HEADER), "https://evil.example", "a client-sent copy is replaced");
  assert.equal(forged.headers.get("origin"), "https://toko.adsbook.my.id");
  assert.equal(forged.headers.get("sec-fetch-site"), "same-origin", "presented as same-origin to Astro only");
  const noOrigin = prepareHandoffRequest(new Request("https://toko.adsbook.my.id/api/handoff", { method: "POST", headers: { [HANDOFF_ORIGIN_HEADER]: "https://app.adsbook.id" } }));
  assert.equal(noOrigin.headers.get(HANDOFF_ORIGIN_HEADER), null, "no Origin, no carried origin");
  assert.equal(noOrigin.headers.get("x-adsbook-handoff-fetch-site"), null, "a client-sent fetch-site copy is dropped");
  const other = new Request("https://toko.adsbook.my.id/api/admin/orders", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(prepareHandoffRequest(other), other, "every other path keeps Astro's check");
});

// ---------------------------------------------------------------- T-27 ----

test("T-27: TOTP matches the RFC 6238 SHA-1 test vector", async () => {
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
  assert.equal(await totpCode(secret, 1), "287082"); // T = 59 s
  assert.equal(await totpCode(secret, Math.floor(1111111109 / 30)), "081804");
});

const PLATFORM_SECRET = "platform-auth-secret-for-tests-0123456789";

async function platformHarness() {
  const harness = await signupHarness();
  harness.env.PLATFORM_AUTH_SECRET = PLATFORM_SECRET;
  const users: Record<string, { totp: string }> = {};
  const addUser = async (email: string, role: "platform_owner" | "platform_support", enrolled = true) => {
    const totp = newTotpSecret();
    harness.platformDb.sqlite
      .prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES (?, ?, ?, ?, ?, '2026-11-16')")
      .run(`pu_${role}_${email.length}`, email, await hashAdminPassword("operator-password-1"), enrolled ? totp : null, role);
    users[email] = { totp };
  };
  const login = async (email: string, code?: string) =>
    platformLogin(harness.env, { email, password: "operator-password-1", totp: code ?? (await totpCode(users[email].totp, Math.floor(Date.now() / 30_000))) }, `198.51.100.${email.length}`);
  return { ...harness, addUser, login, users };
}

test("T-27/IAM-3: platform sign-in needs the password AND a TOTP code; no enrolment, no sign-in", async () => {
  const { addUser, login } = await platformHarness();
  await addUser("owner@ops.example", "platform_owner");
  await addUser("unenrolled@ops.example", "platform_owner", false);
  assert.equal((await login("owner@ops.example", "000000")).ok, false, "a wrong code");
  assert.equal((await login("unenrolled@ops.example", "123456")).ok, false, "MFA is required");
  const ok = await login("owner@ops.example");
  assert.equal(ok.ok, true);
});

test("T-27: ISO-12/AUTHZ-4 — a tenant session never opens platform admin, a platform session never opens a seller admin", async () => {
  const { env, run, stores, addUser, login } = await platformHarness();
  await addUser("owner@ops.example", "platform_owner");
  const signed = await login("owner@ops.example");
  assert.ok(signed.ok);
  const tenant = await run("iso-dua-belas");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201 || !signed.ok) return;
  const database = createTenantDb(stores.get(tenant.tenantId).stub);
  const secret = await resolveAuthSecret(database, tenant.tenantId);
  const { token, session } = await signJwt({ username: "owner@iso-dua-belas.example", role: "owner" }, secret);
  await storeAdminSession(database, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });

  const onRequest = createMiddleware();
  const send = async (host: string, path: string, cookie: string, route: { GET?: (context: never) => Promise<Response> | Response }) => {
    const href = `https://${host}${path}`;
    const context = { request: new Request(href, { headers: { cookie } }), url: new URL(href), locals: { runtimeEnv: env }, routePattern: path, redirect: () => new Response(null, { status: 302 }) };
    const previous = console.log;
    console.log = () => undefined;
    try {
      return ((await onRequest(context as never, (async () => route.GET!(context as never)) as never)) as Response).status;
    } finally {
      console.log = previous;
    }
  };
  assert.equal(await send("app.adsbook.id", "/api/platform/tenants", `${PLATFORM_COOKIE_NAME}=${signed.cookie}`, platformTenantsRoute), 200);
  assert.equal(await send("app.adsbook.id", "/api/platform/tenants", `__Host-adsbook_session=${token}`, platformTenantsRoute), 401, "a tenant session on the platform");
  assert.equal(await send("iso-dua-belas.adsbook.my.id", "/api/admin/orders", `${PLATFORM_COOKIE_NAME}=${signed.cookie}`, adminOrdersRoute), 401, "a platform session on a seller host");
  assert.equal(await send("iso-dua-belas.adsbook.my.id", "/api/platform/tenants", `${PLATFORM_COOKIE_NAME}=${signed.cookie}`, platformTenantsRoute), 404, "platform routes do not exist on seller hosts");
});

test("T-27/AUTHZ-3: platform_support suspends and resumes but cannot purge, change plan or recover; every action is audited", async () => {
  const { platformDb, run, env } = await platformHarness();
  const tenant = await run("diaudit");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const support = { id: "pu_s", email: "support@ops.example", role: "platform_support" as const };
  const owner = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  for (const action of ["purge-request", "plan", "recover"] as const) {
    const result = await runTenantAction(platformDb, support, tenant.tenantId, action, { slug: "diaudit", plan: "pilot", evidence: "verified by phone and signup email" });
    assert.equal(result.ok, false, action);
    if (!result.ok) assert.equal(result.status, 403, action);
  }
  const version = () => (platformDb.sqlite.prepare("SELECT cache_version AS v, status FROM tenants WHERE id = ?").get(tenant.tenantId) as { v: number; status: string });
  const before = version().v;
  assert.equal((await runTenantAction(platformDb, support, tenant.tenantId, "suspend", { reason: "x" })).ok, false, "a reason is required");
  assert.ok((await runTenantAction(platformDb, support, tenant.tenantId, "suspend", { reason: "laporan penipuan" })).ok);
  assert.deepEqual([version().status, version().v], ["suspended", before + 1], "suspend bumps the cache version");

  // IAM-7: the suspended tenant's host refuses everything, sessions included.
  const onRequest = createMiddleware();
  const href = "https://diaudit.adsbook.my.id/hello";
  const previous = console.log;
  console.log = () => undefined;
  let status = 0;
  try {
    status = ((await onRequest({ request: new Request(href), url: new URL(href), locals: { runtimeEnv: env }, routePattern: "/hello", redirect: () => new Response(null, { status: 302 }) } as never, (async () => new Response("ok")) as never)) as Response).status;
  } finally {
    console.log = previous;
  }
  assert.equal(status, 403);

  assert.ok((await runTenantAction(platformDb, support, tenant.tenantId, "resume", { reason: "sudah diverifikasi" })).ok);
  assert.ok((await runTenantAction(platformDb, owner, tenant.tenantId, "plan", { plan: "pilot" })).ok);
  assert.equal((await runTenantAction(platformDb, owner, tenant.tenantId, "purge-request", { slug: "salah" })).ok, false, "the typed slug must match");
  assert.ok((await runTenantAction(platformDb, owner, tenant.tenantId, "purge-request", { slug: "diaudit" })).ok);
  const events = platformDb.sqlite
    .prepare("SELECT kind, actor, detail_json FROM tenant_events WHERE tenant_id = ? AND actor LIKE 'platform:%' ORDER BY id")
    .all(tenant.tenantId) as Array<{ kind: string; actor: string; detail_json: string }>;
  assert.deepEqual(events.map((event) => event.kind), ["suspended", "resumed", "plan_changed", "purge_requested"]);
  assert.deepEqual(JSON.parse(events[0].detail_json), { reason: "laporan penipuan", before: "active", after: "suspended" });
  assert.equal(events[0].actor, "platform:pu_s");
});

test("T-27/IAM-9: owner recovery sets the password on the seller host and revokes every session; the platform never sees it", async () => {
  const { platformDb, run, stores } = await platformHarness();
  const tenant = await run("pulih");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const database = createTenantDb(stores.get(tenant.tenantId).stub);
  const secret = await resolveAuthSecret(database, tenant.tenantId);
  const { session } = await signJwt({ username: "owner@pulih.example", role: "owner" }, secret);
  await storeAdminSession(database, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });
  const owner = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  const issued = await runTenantAction(platformDb, owner, tenant.tenantId, "recover", { evidence: "telepon ke nomor pendaftaran, cocok" });
  assert.ok(issued.ok && issued.recoveryToken);
  if (!issued.ok || !issued.recoveryToken) return;
  const context = { tenantId: tenant.tenantId, host: "pulih.adsbook.my.id", hostKind: "subdomain" };
  assert.equal((await redeemOwnerRecovery(platformDb, database, { ...context, host: "lain.adsbook.my.id" }, issued.recoveryToken, "password-baru-panjang")).ok, false, "wrong host");
  const redeemed = await redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "password-baru-panjang");
  assert.equal(redeemed.ok, true);
  const credential = await getAdminCredential(database, "owner@pulih.example");
  assert.equal(await verifyAdminLoginPassword("password-baru-panjang", credential!), true);
  assert.equal(await verifyAdminLoginPassword("kata-sandi-panjang-1", credential!), false, "the old password is gone");
  const sessions = stores.get(tenant.tenantId).storage.db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get() as { n: number };
  assert.equal(sessions.n, 0, "every session revoked");
  assert.equal((await redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "password-lain-panjang")).ok, false, "single use");
  const kinds = (platformDb.sqlite.prepare("SELECT kind FROM tenant_events WHERE tenant_id = ? ORDER BY id").all(tenant.tenantId) as Array<{ kind: string }>).map((row) => row.kind);
  assert.ok(kinds.includes("owner_recovery") && kinds.includes("owner_recovery_redeemed"));
  const issuedEvent = platformDb.sqlite.prepare("SELECT detail_json FROM tenant_events WHERE kind = 'owner_recovery'").get() as { detail_json: string };
  assert.doesNotMatch(issuedEvent.detail_json, new RegExp(issued.recoveryToken), "the token is not in the audit row");
});

test("T-27/OBS-3: a stale heartbeat shows on the health page; a successful alarm refreshes it", async () => {
  const { platformDb, run } = await platformHarness();
  const fresh = await run("segar");
  const stale = await run("basi");
  assert.ok(fresh.status === 201 && stale.status === 201);
  if (fresh.status !== 201 || stale.status !== 201) return;
  await recordTenantHealth(platformDb, fresh.tenantId, { ok: true, backlog: 0 });
  await recordTenantHealth(platformDb, stale.tenantId, { ok: true }, new Date(Date.now() - 3 * 3_600_000));
  await recordTenantHealth(platformDb, stale.tenantId, { ok: false, error: "store broken" });
  const health = await platformHealth(platformDb);
  assert.deepEqual(health.staleHeartbeats.map((row) => row.slug), ["basi"]);
  assert.equal(health.staleHeartbeats[0].last_error, "store broken");
});

test("T-27: an unsafe platform call without its own Origin is refused before any action", async () => {
  const { env, addUser, login, run, platformDb } = await platformHarness();
  await addUser("owner@ops.example", "platform_owner");
  const signed = await login("owner@ops.example");
  const tenant = await run("csrf-plat");
  assert.ok(signed.ok && tenant.status === 201);
  if (!signed.ok || tenant.status !== 201) return;
  const onRequest = createMiddleware();
  const post = async (headers: Record<string, string>) => {
    const href = `https://app.adsbook.id/api/platform/tenants/${tenant.tenantId}/suspend`;
    const request = new Request(href, { method: "POST", headers: { cookie: `${PLATFORM_COOKIE_NAME}=${signed.cookie}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ reason: "uji csrf" }) });
    const context = { request, url: new URL(href), params: { id: tenant.tenantId, action: "suspend" }, locals: { runtimeEnv: env }, routePattern: "/api/platform/tenants/[id]/[action]", redirect: () => new Response(null, { status: 302 }) };
    const previous = console.log;
    console.log = () => undefined;
    try {
      return ((await onRequest(context as never, (async () => platformActionRoute.POST(context as never)) as never)) as Response).status;
    } finally {
      console.log = previous;
    }
  };
  assert.equal(await post({ "sec-fetch-site": "same-site", origin: "https://evil.adsbook.id" }), 403);
  assert.equal(await post({}), 403, "no Origin");
  assert.equal((platformDb.sqlite.prepare("SELECT status FROM tenants WHERE id = ?").get(tenant.tenantId) as { status: string }).status, "active");
  assert.equal(await post({ origin: "https://app.adsbook.id", "sec-fetch-site": "same-origin" }), 200);
  assert.equal((platformDb.sqlite.prepare("SELECT status FROM tenants WHERE id = ?").get(tenant.tenantId) as { status: string }).status, "suspended");
});

test("T-27 review: an accepted TOTP code signs in once", async () => {
  const { addUser, login, users } = await platformHarness();
  await addUser("owner@ops.example", "platform_owner");
  const code = await totpCode(users["owner@ops.example"].totp, Math.floor(Date.now() / 30_000));
  const [first, second] = await Promise.all([login("owner@ops.example", code), login("owner@ops.example", code)]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1, "two sessions from one code");
  assert.equal((await login("owner@ops.example", code)).ok, false, "a replay");
});

test("T-27 review: a refused transition, purge request or stale plan change writes no audit row", async () => {
  const { platformDb, run } = await platformHarness();
  const tenant = await run("audit-jujur");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const owner = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  const count = () => (platformDb.sqlite.prepare("SELECT COUNT(*) AS n FROM tenant_events WHERE tenant_id = ? AND actor LIKE 'platform:%'").get(tenant.tenantId) as { n: number }).n;
  assert.ok((await runTenantAction(platformDb, owner, tenant.tenantId, "suspend", { reason: "pertama" })).ok);
  assert.equal((await runTenantAction(platformDb, owner, tenant.tenantId, "suspend", { reason: "kedua" })).ok, false);
  assert.ok((await runTenantAction(platformDb, owner, tenant.tenantId, "purge-request", { slug: "audit-jujur" })).ok);
  assert.equal((await runTenantAction(platformDb, owner, tenant.tenantId, "purge-request", { slug: "audit-jujur" })).ok, false);
  assert.equal(count(), 2, "only the two actions that happened are audited");
});

test("T-27 review: a refused recovery attempt does not spend the token; issuance and completion are linked", async () => {
  const { platformDb, run, stores } = await platformHarness();
  const tenant = await run("tautan");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const database = createTenantDb(stores.get(tenant.tenantId).stub);
  const owner = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  const issued = await runTenantAction(platformDb, owner, tenant.tenantId, "recover", { evidence: "verifikasi lewat telepon terdaftar" });
  assert.ok(issued.ok && issued.recoveryToken);
  if (!issued.ok || !issued.recoveryToken) return;
  const context = { tenantId: tenant.tenantId, host: "tautan.adsbook.my.id", hostKind: "subdomain" };
  assert.equal((await redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "owner@tautan.example")).ok, false, "the email as password");
  assert.equal((await redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "pendek")).ok, false);
  assert.equal((await redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "akhirnya-password-benar")).ok, true, "the token survived the refusals");
  const rows = platformDb.sqlite
    .prepare("SELECT kind, detail_json FROM tenant_events WHERE tenant_id = ? AND kind IN ('owner_recovery', 'owner_recovery_redeemed') ORDER BY id")
    .all(tenant.tenantId) as Array<{ kind: string; detail_json: string }>;
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0].detail_json).issuance, JSON.parse(rows[1].detail_json).issuance, "completion linked to its issuance");
  assert.ok(rows.every((row) => !row.detail_json.includes(issued.recoveryToken!)), "no audit row holds the token");
});

test("T-27 review: the public platform sign-in is strict same-origin too", async () => {
  const { platformGuard } = await import("./admin/guard.ts");
  const href = "https://app.adsbook.id/api/platform/login";
  const guard = (headers: Record<string, string>) => platformGuard(new Request(href, { method: "POST", headers }), new URL(href), {});
  assert.equal((await guard({})).kind, "deny", "no Origin");
  assert.equal((await guard({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })).kind, "deny");
  assert.equal((await guard({ origin: "https://app.adsbook.id", "sec-fetch-site": "same-origin" })).kind, "pass");
});

test("T-27 review: concurrent recoveries — one wins, the loser changes nothing; a missing owner keeps sessions and token", async () => {
  const { platformDb, run, stores } = await platformHarness();
  const tenant = await run("balapan-pulih");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const database = createTenantDb(stores.get(tenant.tenantId).stub);
  const operator = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  const context = { tenantId: tenant.tenantId, host: "balapan-pulih.adsbook.my.id", hostKind: "subdomain" };
  const issued = await runTenantAction(platformDb, operator, tenant.tenantId, "recover", { evidence: "verifikasi lewat telepon terdaftar" });
  assert.ok(issued.ok && issued.recoveryToken);
  if (!issued.ok || !issued.recoveryToken) return;
  const results = await Promise.all([
    redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "password-pemenang-satu"),
    redeemOwnerRecovery(platformDb, database, context, issued.recoveryToken, "password-pemenang-dua"),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const winner = results[0].ok ? "password-pemenang-satu" : "password-pemenang-dua";
  const credential = await getAdminCredential(database, "owner@balapan-pulih.example");
  assert.equal(await verifyAdminLoginPassword(winner, credential!), true, "the loser overwrote the winner");

  // The owner row is gone: no session is deleted and the token is not spent.
  const second = await runTenantAction(platformDb, operator, tenant.tenantId, "recover", { evidence: "verifikasi lewat telepon terdaftar" });
  assert.ok(second.ok && second.recoveryToken);
  if (!second.ok || !second.recoveryToken) return;
  const secret = await resolveAuthSecret(database, tenant.tenantId);
  const { session } = await signJwt({ username: "staff.cs", role: "customer_service" }, secret);
  await storeAdminSession(database, session, { mustChangePassword: false, updatedAt: "2026-11-16T00:00:00.000Z" });
  stores.get(tenant.tenantId).storage.db.exec("UPDATE admin_credentials SET role = 'admin' WHERE role = 'owner'");
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await redeemOwnerRecovery(platformDb, database, context, second.recoveryToken, "password-tanpa-owner")).ok, false);
  } finally {
    console.error = original;
  }
  assert.equal((stores.get(tenant.tenantId).storage.db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get() as { n: number }).n, 1, "sessions deleted without an owner change");
  // The code was spent at the fence, so the failure is audited and a new code is needed.
  const failure = platformDb.sqlite.prepare("SELECT detail_json FROM tenant_events WHERE tenant_id = ? AND kind = 'owner_recovery_failed'").get(tenant.tenantId) as { detail_json: string };
  assert.equal(JSON.parse(failure.detail_json).reason, "owner_missing");
  assert.equal((await redeemOwnerRecovery(platformDb, database, context, second.recoveryToken, "password-tanpa-owner")).ok, false, "never twice");
});

test("T-27 review: a recovery whose outcome cannot be recorded stays visible as unresolved", async () => {
  const { platformDb, run, stores } = await platformHarness();
  const tenant = await run("tak-tercatat");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const database = createTenantDb(stores.get(tenant.tenantId).stub);
  const operator = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  const issued = await runTenantAction(platformDb, operator, tenant.tenantId, "recover", { evidence: "verifikasi lewat telepon terdaftar" });
  assert.ok(issued.ok && issued.recoveryToken);
  if (!issued.ok || !issued.recoveryToken) return;
  // The tenant write fails AND the outcome row cannot be written.
  const broken = { ...database, batch: async () => { throw new Error("store down"); } } as unknown as D1Database;
  const logged: string[] = [];
  const original = console.error;
  console.error = (label: unknown) => void logged.push(String(label));
  platformDb.failWhen = /owner_recovery_failed|VALUES \(\?, \?, 'platform'/;
  try {
    const result = await redeemOwnerRecovery(platformDb, broken, { tenantId: tenant.tenantId, host: "tak-tercatat.adsbook.my.id", hostKind: "subdomain" }, issued.recoveryToken, "password-baru-panjang", new Date(Date.now() - 10 * 60_000));
    assert.equal(result.ok, false);
  } finally {
    platformDb.failWhen = null;
    console.error = original;
  }
  assert.ok(logged.includes("owner-recovery-outcome-unrecorded"), "the lost audit row is logged, not swallowed");
  const health = await platformHealth(platformDb);
  assert.deepEqual(health.unresolvedRecoveries.map((row) => row.slug), ["tak-tercatat"]);
});

test("T-27 review: every unresolved recovery is listed, beyond any page size", async () => {
  const { platformDb } = await platformHarness();
  const insert = platformDb.sqlite.prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, 'owner_recovery_redeemed', 'owner', ?, ?)");
  for (let index = 0; index < 60; index += 1) insert.run(`t_r${index}`, new Date(Date.now() - (index + 10) * 60_000).toISOString(), JSON.stringify({ issuance: `i${index}`, outcome: "pending" }));
  platformDb.sqlite.prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES ('t_r0', 'owner_recovery_completed', 'platform', ?, ?)").run(new Date().toISOString(), JSON.stringify({ issuance: "i0" }));
  assert.equal((await platformHealth(platformDb)).unresolvedRecoveries.length, 59);
});

// ---- T-38: store readiness (PR-23, UX-2, UX-5) ----

async function readinessHarness(slug: string, options: { preview?: boolean } = {}) {
  const { stores, env, run } = await signupHarness();
  const created = await run(slug);
  assert.equal(created.status, 201);
  if (created.status !== 201) throw new Error("signup failed");
  // A signup lands in Preview Mode (ADR-041); these stores are paid for unless asked.
  if (!options.preview) {
    await (env.PLATFORM_DB as D1Database)
      .prepare("UPDATE tenants SET subscription_ends_at = '2099-01-01T00:00:00.000Z', grace_ends_at = '2099-01-03T00:00:00.000Z' WHERE id = ?")
      .bind(created.tenantId)
      .run();
  }
  const sql = stores.get(created.tenantId).storage.db;
  // Bound like the platform binds it (ADR-040): the same tenant id and env.
  const database = bindCredentials(createTenantDb(stores.get(created.tenantId).stub), created.tenantId, env);
  const host = `${slug}.adsbook.my.id`;
  /** One request through the real middleware: the status, and whether the route ran. */
  const open = async (path: string, method = "GET", cookie?: string) => {
    const href = `https://${host}${path}`;
    let reached = false;
    const onRequest = createMiddleware();
    const original = { log: console.log, info: console.info };
    console.log = console.info = () => undefined;
    try {
      const response = (await onRequest(
        {
          request: new Request(href, { method, headers: { ...(method === "GET" ? {} : { origin: `https://${host}`, "sec-fetch-site": "same-origin" }), ...(cookie ? { cookie } : {}) } }),
          url: new URL(href),
          locals: { runtimeEnv: env },
          routePattern: path,
          redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
        } as never,
        (async () => ((reached = true), new Response("ok"))) as never,
      )) as Response;
      return { status: response.status, reached, body: await response.text(), robots: response.headers.get("x-robots-tag"), cacheControl: response.headers.get("cache-control") };
    } finally {
      Object.assign(console, original);
    }
  };
  const product = () =>
    sql.exec(`INSERT INTO products (id, store_id, title, slug, is_active, created_at) VALUES (1, 1, 'Kopi', 'kopi', 1, '2026-11-16');
              INSERT INTO product_variants (product_id, sku, title, price, weight_grams) VALUES (1, 'KOPI-1', 'Kopi 250g', 85000, 300);`);
  const warehouse = (id: number, primary: 0 | 1, origin: string, pickup: string) =>
    sql.prepare(`INSERT INTO warehouses (id, store_id, name, origin_area_id, pickup_address_id, address, city, province, is_primary, is_active)
                 VALUES (?, 1, ?, ?, ?, 'Jl. Contoh 1', 'Bandung', 'Jawa Barat', ?, 1)`).run(id, `Gudang ${id}`, origin, pickup, primary);
  const mengantar = () => sql.exec("UPDATE stores SET mengantar_api_key = 'mengantar-test-key'");
  const facts = async () => readReadiness(database);
  return { open, product, warehouse, mengantar, facts, sql, database, env, tenantId: created.tenantId, stub: stores.get(created.tenantId).stub };
}

test("PR-23 owner preview: the signed-in owner sees the unready storefront, buyers and checkout stay closed", async () => {
  const store = await readinessHarness("pratinjau-pemilik");
  // Buyers: the neutral page, with a sign-in link for the owner and nothing else.
  const anonymous = await store.open("/");
  assert.equal(anonymous.status, 503);
  assert.equal(anonymous.reached, false);
  assert.match(anonymous.body, /Toko belum siap/);
  assert.match(anonymous.body, /href="\/hello"/);
  // The owner, signed in on this host.
  const secret = await resolveAuthSecret(store.database, store.tenantId);
  const credential = (await getAdminCredential(store.database, "owner@pratinjau-pemilik.example"))!;
  const { token, session } = await signJwt({ username: credential.username, role: credential.role }, secret);
  await storeAdminSession(store.database, session, credential);
  const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
  for (const path of ["/", "/produk/kopi", "/kebijakan-privasi"]) {
    const page = await store.open(path, "GET", cookie);
    assert.equal(page.reached, true, `${path} renders for the owner`);
    assert.equal(page.robots, "noindex, nofollow", `${path} is not indexed`);
    assert.match(page.cacheControl ?? "", /private/, `${path} is private`);
  }
  // Checkout and quotes stay closed even for the owner, and a forged cookie opens nothing.
  for (const [path, method] of [["/api/submit-order", "POST"], ["/api/shipping-options", "GET"]] as const) {
    assert.equal((await store.open(path, method, cookie)).status, 503, path);
  }
  assert.equal((await store.open("/", "GET", `${SESSION_COOKIE_NAME}=forged.token.value`)).status, 503);
});

test("T-38: a new store says 'toko belum siap' (no checkout) until the ready predicate holds, and opens right after", async () => {
  const store = await readinessHarness("siap-jualan");
  for (const [path, method] of [["/", "GET"], ["/produk/kopi", "GET"], ["/api/submit-order", "POST"], ["/api/v1/checkout", "POST"], ["/api/shipping-rates", "GET"], ["/thanks", "GET"]] as const) {
    const response = await store.open(path, method);
    assert.equal(response.status, 503, path);
    assert.equal(response.reached, false, `${path} reached its route on an unready store`);
    assert.match(response.body, path.startsWith("/api/") ? /STORE_NOT_READY/ : /Toko belum siap/, path);
  }
  // The owner's way in stays open: sign-in renders, admin answers its own
  // session gate (redirect / 401), never the not-ready page.
  assert.equal((await store.open("/hello")).reached, true);
  assert.equal((await store.open("/api/locations")).reached, true, "the warehouse step's area lookup");
  assert.equal((await store.open("/api/ops/v1/orders")).reached, true, "read-only ops");
  assert.equal((await store.open("/api/ops/v1/orders", "POST")).status, 503, "an ops write stays gated");
  // `/api/admin/payment-methods` too: the Pembayaran page reads its list there,
  // because the public `/api/payment-methods` is (rightly) closed until ready.
  for (const path of ["/admin", "/admin/setup", "/admin/payments", "/api/admin/products", "/api/admin/payment-methods"]) {
    const response = await store.open(path);
    assert.ok(response.status === 302 || response.status === 401, `${path} → ${response.status}`);
    assert.doesNotMatch(response.body, /belum siap|STORE_NOT_READY/, path);
  }
  assert.equal((await store.open("/api/payment-methods")).status, 503, "the buyer-facing list stays closed until ready");

  // Step by step: closed until the last required step, open right after.
  const required = async () => {
    const steps = buildSetupChecklist({ ...(await store.facts()), customDomain: false });
    return steps.filter((step) => step.required && !step.done).map((step) => step.id);
  };
  assert.deepEqual(await required(), ["product", "warehouse", "mengantar"], "signup sets the name; COD and couriers start on");
  store.product();
  assert.deepEqual(await required(), ["warehouse", "mengantar"]);
  assert.equal((await store.open("/")).status, 503);
  store.mengantar();
  assert.deepEqual(await required(), ["warehouse"], "COD on, product present, Mengantar set: still the warehouse");
  assert.equal((await store.open("/")).status, 503);
  store.warehouse(1, 1, "12345", "pickup-1");
  assert.deepEqual(await required(), []);
  const opened = await store.open("/produk/kopi");
  assert.equal(opened.reached, true, "the store opens the moment the predicate holds");
  assert.equal((await store.open("/api/submit-order", "POST")).reached, true);

  // And closes again if a required fact goes away (derived, never stored).
  store.sql.exec("UPDATE stores SET mengantar_api_key = NULL");
  assert.equal((await store.open("/")).status, 503);
});

test("T-38/PR-23: COD + product without a Mengantar key is not ready", async () => {
  const store = await readinessHarness("tanpa-mengantar");
  store.product();
  store.warehouse(1, 1, "12345", "pickup-1");
  const facts = await store.facts();
  assert.equal(facts.payment, true);
  assert.equal(isStoreReady(facts), false);
  assert.equal((await store.open("/")).status, 503);
});

test("T-38/PR-23: a primary warehouse without origin or pickup is not ready, however complete a secondary one is", async () => {
  for (const [origin, pickup] of [["", "pickup-1"], ["12345", ""]]) {
    const store = await readinessHarness(`gudang-${origin ? "tanpa-pickup" : "tanpa-origin"}`);
    store.product();
    store.mengantar();
    store.warehouse(1, 1, origin, pickup);
    store.warehouse(2, 0, "67890", "pickup-2");
    assert.equal(isStoreReady(await store.facts()), false, `origin=${origin} pickup=${pickup}`);
    assert.equal((await store.open("/")).status, 503);
    // An inactive primary is not ready either.
    store.sql.exec("UPDATE warehouses SET origin_area_id = '12345', pickup_address_id = 'pickup-1', is_active = 0 WHERE id = 1");
    assert.equal(isStoreReady(await store.facts()), false, "inactive primary");
  }
});

test("T-38: payment, product price/weight and couriers each gate readiness; optional steps never do", async () => {
  const store = await readinessHarness("syarat-lengkap");
  store.product();
  store.mengantar();
  store.warehouse(1, 1, "12345", "pickup-1");
  assert.equal(isStoreReady(await store.facts()), true);
  store.sql.exec("UPDATE stores SET is_cod_enabled = 0");
  assert.equal((await store.facts()).payment, false, "COD off and AutoLaris without its key");
  store.sql.exec("UPDATE stores SET autolaris_api_key = 'k', autolaris_order_origin_id = '1', autolaris_order_destination_id = '2'");
  assert.equal(isStoreReady(await store.facts()), true, "AutoLaris with what its rail validates");
  store.sql.exec("UPDATE product_variants SET weight_grams = 0");
  assert.equal(isStoreReady(await store.facts()), false, "a product without weight");
  store.sql.exec("UPDATE product_variants SET weight_grams = 300; UPDATE courier_rules SET is_enabled = 0");
  assert.equal(isStoreReady(await store.facts()), false, "no courier, no quote");
  store.sql.exec("UPDATE courier_rules SET is_enabled = 1");
  const ready = await store.facts();
  assert.equal(ready.signals, false);
  assert.equal(isStoreReady(ready), true, "no domain and no pixel: still ready");
  // The checklist through the page's own reader, with the control plane's custom-domain fact.
  const setup = await readSetupFacts(store.database, { tenantContext: { tenantId: store.tenantId }, runtimeEnv: store.env } as never);
  assert.ok(setup);
  const steps = buildSetupChecklist(setup!);
  assert.deepEqual(steps.map((step) => [step.id, step.required, step.done]), [
    ["store", true, true], ["product", true, true], ["warehouse", true, true], ["mengantar", true, true],
    ["couriers", true, true], ["payment", true, true], ["domain", false, false], ["signals", false, false],
  ]);
});

test("T-38: an unreadable store fails closed (503, no route), never open", async () => {
  const store = await readinessHarness("tak-terbaca");
  store.product();
  store.mengantar();
  store.warehouse(1, 1, "12345", "pickup-1");
  store.sql.exec("DROP TABLE courier_rules");
  const original = console.error;
  console.error = () => undefined;
  try {
    const response = await store.open("/");
    assert.equal(response.status, 503);
    assert.equal(response.reached, false);
  } finally {
    console.error = original;
  }
});

// ---- T-39: accepted versions and the store's providers (PR-24, PRIV-2) ----

test("T-39/PR-24: signup without the terms is refused; an accepted signup stores both text versions", async () => {
  const { platformDb, env, input, run } = await signupHarness();
  const refused = await signup(env, { ...input("tanpa-setuju"), terms: false }, "198.51.100.40", { verifyTurnstile: async () => true });
  assert.equal(refused.status, 400);
  assert.equal(platformDb.sqlite.prepare("SELECT COUNT(*) AS n FROM tenants WHERE slug = 'tanpa-setuju'").get()!.n, 0);
  const created = await run("setuju-versi");
  assert.equal(created.status, 201);
  const event = platformDb.sqlite.prepare("SELECT detail_json FROM tenant_events WHERE kind = 'signup' AND tenant_id = ?").get((created as { tenantId: string }).tenantId) as { detail_json: string };
  // Seller terms v0.3 (2026-11-16, ADR-041): paid subscription with Preview Mode, seller zone
  // adsbook.my.id; v0.1 and v0.2 stay served for those who accepted them.
  assert.deepEqual(JSON.parse(event.detail_json), { terms_version: "0.3", privacy_version: "0.1" });
  assert.equal(TERMS_VERSION, "0.3");
  assert.ok(legalText("seller-terms", "0.3") && legalText("seller-terms", "0.2") && legalText("seller-terms", "0.1") && legalText("platform-privacy", "0.1"), "every accepted version is served");
  assert.match(legalText("seller-terms", "0.2")!.text, /\{slug\}\.adsbook\.cc/);
  assert.match(legalText("seller-terms", "0.3")!.text, /\{slug\}\.adsbook\.my\.id/);
  assert.match(legalText("seller-terms", "0.3")!.text, /Rp149\.000[\s\S]*Rp1\.490\.000[\s\S]*48 jam/);
});

test("T-39/PRIV-2: the store notice's providers come from the store's saved credentials", async () => {
  const store = await readinessHarness("notice-provider");
  assert.deepEqual(await readStoreProviders(store.database), { meta: false, google: false, mengantar: false, autolaris: false, kelola: false });
  store.sql.exec("UPDATE stores SET meta_pixel_id = '123456789012345'");
  store.mengantar();
  const providers = await readStoreProviders(store.database);
  assert.deepEqual(providers, { meta: true, google: false, mengantar: true, autolaris: false, kelola: false });
  const notice = storePrivacyMarkdown(legalText("store-privacy")!.text, providers, "");
  assert.match(notice, /Meta/);
  assert.doesNotMatch(notice, /Google/);
  store.sql.exec("UPDATE stores SET is_autolaris_enabled = 1, autolaris_api_key = 'k'");
  assert.equal((await readStoreProviders(store.database)).autolaris, true);
  store.sql.exec("UPDATE stores SET is_autolaris_enabled = 0");
  assert.equal((await readStoreProviders(store.database)).autolaris, true, "a saved key is named even with the checkout rail off");
  store.sql.exec("UPDATE stores SET autolaris_api_key = NULL");
  assert.equal((await readStoreProviders(store.database)).autolaris, false);
});

// ---- T-41: the display-only demo store (PR-26) ----

test("T-41/PR-26: the demo store browses without readiness, refuses every provider route and write, and sends nothing", async () => {
  const store = await readinessHarness("demo");
  const platformDb = store.env.PLATFORM_DB as ReturnType<typeof createSqliteD1>;
  // Every platform environment provider value set: none of it may be used.
  Object.assign(store.env, {
    MENGANTAR_API_KEY: "env-mengantar", AUTOLARIS_API_KEY: "env-autolaris", META_PIXEL_ID: "100000000000002", META_CAPI_TOKEN: "env-capi",
    GOOGLE_ADS_DEVELOPER_TOKEN: "env-google", KELOLA_API_KEY: "env-kelola", PLATFORM_META_PIXEL_ID: "100000000000001", PLATFORM_META_CAPI_TOKEN: "env-platform",
  });
  platformDb.sqlite.exec("UPDATE tenants SET is_demo = 1, cache_version = cache_version + 1 WHERE slug = 'demo'");
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("an outbound request left the demo store");
  }) as typeof fetch;
  try {
    // Browsing: the unready demo store still renders its pages.
    for (const path of ["/", "/produk/x", "/kebijakan-privasi"]) {
      assert.equal((await store.open(path)).reached, true, `${path} renders on the demo store`);
    }
    // District search, quotes, payment methods, geo: refused before the route.
    for (const path of ["/api/locations?search=bandung", "/api/shipping-rates", "/api/shipping-options", "/api/payment-methods", "/api/v1/geo/provinces"]) {
      const response = await store.open(path);
      assert.equal(response.status, 403, path);
      assert.equal(response.reached, false, `${path} reached its route`);
      assert.match(response.body, /DEMO_STORE/, path);
    }
    // Both order submits, abandoned leads, browser events, headless checkout, admin writes.
    // ...and a subscription invoice: the demo store never pays (it has no billing to pay).
    for (const path of ["/api/submit-order", "/api/submit-middle-order", "/api/record-abandoned-order", "/api/meta-event", "/api/v1/checkout", "/api/admin/settings", "/api/admin/domains", "/api/admin/products", "/api/admin/billing"]) {
      const response = await store.open(path, "POST");
      assert.equal(response.status, 403, path);
      assert.equal(response.reached, false, `${path} reached its route`);
    }
    // Signing in still works (the owner can look).
    assert.equal((await store.open("/hello", "POST")).reached, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, [], "no outbound request");
  // No provider credential is stored for it.
  const row = store.sql.prepare("SELECT mengantar_api_key, autolaris_api_key, meta_capi_token FROM stores").get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { mengantar_api_key: null, autolaris_api_key: null, meta_capi_token: null });
});

test("T-41/PR-26: one demo tenant at most, its usage is not counted, and an ordinary unready store is still closed", async () => {
  const demo = await readinessHarness("demo");
  const platformDb = demo.env.PLATFORM_DB as ReturnType<typeof createSqliteD1>;
  platformDb.sqlite.exec("UPDATE tenants SET is_demo = 1 WHERE slug = 'demo'");
  const other = platformDb.sqlite.prepare("SELECT id FROM tenants WHERE slug = 'demo'").get() as { id: string };
  platformDb.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-second', 'kedua', 'k@example.test', 'active', '2026-11-16')").run();
  assert.throws(() => platformDb.sqlite.exec("UPDATE tenants SET is_demo = 1 WHERE id = 't-second'"), /UNIQUE/, "a second demo tenant");
  await recordUsage(platformDb as unknown as D1Database, other.id, { mediaBytes: 100 });
  await recordUsage(platformDb as unknown as D1Database, "t-second", { mediaBytes: 100 });
  const rows = platformDb.sqlite.prepare("SELECT tenant_id FROM tenant_usage_daily").all().map((r) => (r as { tenant_id: string }).tenant_id);
  assert.deepEqual(rows, ["t-second"], "the demo store's usage is excluded");

  const ordinary = await readinessHarness("biasa-belum-siap");
  const response = await ordinary.open("/");
  assert.equal(response.status, 503);
  assert.match(response.body, /Toko belum siap/);
});

// ---- T-47: an embed-form order sends exactly one server Purchase (A-55) ----

test("T-47/A-55: an order from /embed/form through the real middleware and route sends exactly one server Purchase", async () => {
  const store = await readinessHarness("embed-satu");
  store.product();
  store.warehouse(1, 1, "ORIGIN-1", "pickup-1");
  store.mengantar();
  store.sql.exec(`UPDATE stores SET meta_pixel_id = '100000000000009', meta_capi_token = 'tenant-capi-token';
    INSERT INTO courier_rules (store_id, courier_code, is_enabled, is_cod_enabled) SELECT 1, 'jne', 1, 1 WHERE NOT EXISTS (SELECT 1 FROM courier_rules WHERE courier_code = 'jne');
    UPDATE courier_rules SET is_cod_enabled = 1 WHERE courier_code = 'jne';`);
  const variant = store.sql.prepare("SELECT id FROM product_variants WHERE sku = 'KOPI-1'").get() as { id: number };
  const graph: Array<{ url: string; body: { data: Array<{ event_name: string; event_id: string }> } }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://graph.facebook.com/")) {
      graph.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ events_received: 1 });
    }
    if (url.includes("/order/estimate")) return Response.json({ success: true, data: { JNE: { price: 18000, estimate_delivery: "2-3" } } });
    if (url.includes("/getReceiverScoreByNumberUser")) return Response.json({ success: true, data: {} });
    return Response.json({ success: true, data: [] });
  }) as typeof fetch;
  const tasks: Promise<unknown>[] = [];
  const host = "embed-satu.adsbook.my.id";
  const href = `https://${host}/api/submit-order`;
  const body = {
    submit_token: "embed-form-token-0001", website: "", customer_name: "Rina Lestari", customer_phone: "081234567890",
    address: "Jl. Melati No. 12, Sukajadi", district: "Sukajadi", city: "Bandung", province: "Jawa Barat",
    payment_method: "cod", variant_id: String(variant.id), quantity: 1, location_id: "DEST-1",
    courier_service_id: 1, shipment_provider_code: "JNE", shipping_cost: 18000,
  };
  const quiet = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => undefined;
  try {
    const onRequest = createMiddleware();
    const locals: Record<string, unknown> = { runtimeEnv: store.env, cfContext: { waitUntil: (task: Promise<unknown>) => void tasks.push(task) } };
    const response = (await onRequest(
      {
        // The embed form posts from its own frame, same origin as the store.
        request: new Request(href, {
          method: "POST",
          headers: { "content-type": "application/json", origin: `https://${host}`, "sec-fetch-site": "same-origin", referer: `https://${host}/embed/form?product=kopi` },
          body: JSON.stringify(body),
        }),
        url: new URL(href),
        locals,
        routePattern: "/api/submit-order",
        redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
      } as never,
      (async () => submitOrderRoute.POST({ request: new Request(href, { method: "POST", headers: { "content-type": "application/json", origin: `https://${host}` }, body: JSON.stringify(body) }), locals } as never)) as never,
    )) as Response;
    const payload = (await response.json()) as { success: boolean; order?: { order_number: string }; error?: string };
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.ok(payload.order?.order_number);
    await Promise.all(tasks);
    const purchases = graph.flatMap((call) => call.body.data).filter((event) => event.event_name === "Purchase");
    assert.equal(purchases.length, 1, "exactly one server Purchase");
    assert.equal(purchases[0].event_id, payload.order!.order_number, "keyed by the order number, as the browser leg");
    const outbox = store.sql.prepare("SELECT COUNT(*) AS n FROM capi_event_outbox WHERE event_name = 'Purchase'").get() as { n: number };
    assert.equal(outbox.n, 1, "one Purchase row in the outbox");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }
});

// ---- T-43: www -> root once the root is the active primary (PR-28) ----

test("T-43/HOST-6: www redirects to the root once the root is the active primary; APIs never move; a non-primary root keeps www", async () => {
  const platformDb = await platform([["m-a", "active", "m-a.adsbook.my.id"]]);
  const stores = namespace({ migrated: true });
  stores.get("m-a").storage.db.exec("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Merchant', 'm-a', '2026-11-16')");
  makeReady(stores.get("m-a").storage.db);
  platformDb.sqlite.exec(`
    UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = 'm-a';
    INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at) VALUES
      ('merchant.com', 'm-a', 'custom', 'merchant.com', 'active', 1, '2026-11-16'),
      ('www.merchant.com', 'm-a', 'custom', 'merchant.com', 'active', 0, '2026-11-16');`);
  const onRequest = createMiddleware();
  const ask = async (href: string) => {
    let reached = false;
    const original = { log: console.log, info: console.info };
    console.log = console.info = () => undefined;
    try {
      const response = (await onRequest(
        { request: new Request(href), url: new URL(href), locals: { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } }, routePattern: "/", redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }) } as never,
        (async () => ((reached = true), new Response("ok"))) as never,
      )) as Response;
      return { status: response.status, location: response.headers.get("location"), reached };
    } finally {
      Object.assign(console, original);
    }
  };
  assert.deepEqual(await ask("https://www.merchant.com/produk/kopi?utm_source=fb"), { status: 301, location: "https://merchant.com/produk/kopi?utm_source=fb", reached: false });
  assert.equal((await ask("https://merchant.com/produk/kopi")).reached, true, "the root serves the store");
  assert.equal((await ask("https://www.merchant.com/api/order-status")).status !== 301, true, "APIs and webhooks never move");

  // While the root is not the primary (still pending its probe), www is not redirected.
  platformDb.sqlite.exec("UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = 'm-a'; UPDATE tenant_hosts SET is_primary = 1 WHERE host = 'm-a.adsbook.my.id'; UPDATE tenants SET cache_version = cache_version + 1 WHERE id = 'm-a'");
  await new Promise((resolve) => setTimeout(resolve, 5_100)); // the gate's host cache (5 s)
  assert.equal((await ask("https://www.merchant.com/produk/kopi")).status !== 301, true);
});

// ---- T-44: operator notices through the real middleware (PR-29) ----

test("T-44/PR-29: one 'ready' and one 'first order' notice through the real middleware, neither with buyer data", async () => {
  const store = await readinessHarness("kabar-satu");
  store.product();
  store.warehouse(1, 1, "ORIGIN-1", "pickup-1");
  store.mengantar();
  store.sql.exec(`INSERT INTO courier_rules (store_id, courier_code, is_enabled, is_cod_enabled) SELECT 1, 'jne', 1, 1 WHERE NOT EXISTS (SELECT 1 FROM courier_rules WHERE courier_code = 'jne');
    UPDATE courier_rules SET is_cod_enabled = 1 WHERE courier_code = 'jne';`);
  Object.assign(store.env, { PLATFORM_ALERT_WEBHOOK_URL: "https://hooks.example/notify" });
  const variant = store.sql.prepare("SELECT id FROM product_variants WHERE sku = 'KOPI-1'").get() as { id: number };
  const notices: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://hooks.example/notify") return (notices.push(JSON.parse(String(init?.body)).text), new Response("ok"));
    if (url.includes("/order/estimate")) return Response.json({ success: true, data: { JNE: { price: 18000 } } });
    if (url.includes("/getReceiverScoreByNumberUser")) return Response.json({ success: true, data: {} });
    return Response.json({ success: true, data: [] });
  }) as typeof fetch;
  const host = "kabar-satu.adsbook.my.id";
  const tasks: Promise<unknown>[] = [];
  const locals = () => ({ runtimeEnv: store.env, cfContext: { waitUntil: (task: Promise<unknown>) => void tasks.push(task) } }) as Record<string, unknown>;
  const order = (token: string) => {
    const href = `https://${host}/api/submit-order`;
    const body = JSON.stringify({
      submit_token: token, website: "", customer_name: "Rina Lestari", customer_phone: "081234567890",
      address: "Jl. Melati No. 12, Sukajadi", district: "Sukajadi", city: "Bandung", province: "Jawa Barat",
      payment_method: "cod", variant_id: String(variant.id), quantity: 1, location_id: "DEST-1",
      courier_service_id: 1, shipment_provider_code: "JNE", shipping_cost: 18000,
    });
    const headers = { "content-type": "application/json", origin: `https://${host}`, "sec-fetch-site": "same-origin" };
    const context = locals();
    return createMiddleware()(
      { request: new Request(href, { method: "POST", headers, body }), url: new URL(href), locals: context, routePattern: "/api/submit-order", redirect: () => new Response(null, { status: 302 }) } as never,
      (async () => submitOrderRoute.POST({ request: new Request(href, { method: "POST", headers, body }), locals: context } as never)) as never,
    ) as Promise<Response>;
  };
  const quiet = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = console.info = console.warn = console.error = () => undefined;
  try {
    // The store is ready: the first storefront request announces it.
    const page = `https://${host}/`;
    await createMiddleware()(
      { request: new Request(page), url: new URL(page), locals: locals(), routePattern: "/", redirect: () => new Response(null, { status: 302 }) } as never,
      (async () => new Response("ok")) as never,
    );
    assert.equal((await order("kabar-satu-token-0001")).status, 200);
    assert.equal((await order("kabar-satu-token-0002")).status, 200);
    await Promise.all(tasks);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }
  assert.equal(notices.filter((text) => text.includes("Toko siap jualan")).length, 1);
  assert.equal(notices.filter((text) => text.includes("Pesanan pertama")).length, 1, "the second order sends nothing");
  for (const text of notices) {
    assert.match(text, /\(kabar-satu\)/);
    assert.doesNotMatch(text, /Rina|0812|6281|Melati|Sukajadi/, "no buyer name, phone or address");
  }
});

test("T-44/PR-29: a signup through the real route sends one notice naming the store and slug", async () => {
  const { env } = await signupHarness();
  Object.assign(env, { PLATFORM_ALERT_WEBHOOK_URL: "https://hooks.example/notify", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_VERIFY_URL: "https://turnstile.test/siteverify" });
  const notices: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://hooks.example/notify") return (notices.push(JSON.parse(String(init?.body)).text), new Response("ok"));
    if (url.startsWith("https://turnstile.test/")) return Response.json({ success: true });
    return Response.json({});
  }) as typeof fetch;
  const tasks: Promise<unknown>[] = [];
  const quiet = { log: console.log, info: console.info };
  console.log = console.info = () => undefined;
  try {
    const href = "https://adsbook.id/api/platform/signup";
    const response = (await platformSignupRoute.POST({
      request: new Request(href, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://adsbook.id", "cf-connecting-ip": "198.51.100.77" },
        body: JSON.stringify({ store_name: "Toko Kabar Baru", slug: "kabar-baru", email: "owner@kabar-baru.example", password: "kata-sandi-panjang-1", terms: true, turnstile_token: "ok" }),
      }),
      url: new URL(href),
      locals: { runtimeEnv: env, cfContext: { waitUntil: (task: Promise<unknown>) => void tasks.push(task) } },
    } as never)) as Response;
    assert.equal(response.status, 201, await response.clone().text());
    // The body carries the one-time handoff token: no cache may keep it (T-28 review).
    assert.equal(response.headers.get("cache-control"), "no-store");
    await Promise.all(tasks);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^\[adsbook\.id\] Seller baru mendaftar: Toko Kabar Baru \(kabar-baru\) — https:\/\/app\.adsbook\.id\/platform\/tenants\/t_/);
});

// ---- T-48 / ADR-040: stored provider credentials are sealed per tenant ----

test("T-48: a key saved through the admin route is stored sealed, opens only on its own store, and fails closed without the platform key", async () => {
  const storeA = await readinessHarness("kunci-a");
  const storeB = await readinessHarness("kunci-b");
  const save = (database: D1Database, env: Record<string, unknown>, key: string) =>
    adminSettingsRoute.PUT({
      request: new Request("https://kunci-a.adsbook.my.id/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save-integrations",
          integrations: { mengantar_api_key: key, mengantar_base_url: "https://api-public.mengantar.com", autolaris_base_url: "https://api-h2h.autolaris.com" },
        }),
      }),
      locals: { admin: { username: "owner", role: "owner", mustChangePassword: false }, tenantDb: database, runtimeEnv: env },
    } as never) as Promise<Response>;
  const stored = (store: typeof storeA) => (store.sql.prepare("SELECT mengantar_api_key AS k FROM stores").get() as { k: string | null }).k;

  const response = await save(storeA.database, storeA.env, "mengantar-rahasia-toko-a");
  assert.equal(response.status, 200, await response.clone().text());
  const sealed = stored(storeA)!;
  assert.match(sealed, /^enc:v1:/);
  assert.doesNotMatch(sealed, /mengantar-rahasia/);
  assert.equal((await getProviderConfig(storeA.database)).mengantar.apiKey, "mengantar-rahasia-toko-a");

  // The same sealed value pasted into another tenant's store opens to nothing there.
  storeB.sql.prepare("UPDATE stores SET mengantar_api_key = ?").run(sealed);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal((await getProviderConfig(storeB.database)).mengantar.apiKey, "");
    assert.equal((await readReadiness(storeB.database)).mengantar, false, "an unreadable key does not make a store ready");
  } finally {
    console.warn = warn;
  }

  // Without the platform key: the save is refused and nothing is written; the stored key reads as not set.
  const keylessEnv = { ...storeA.env, PLATFORM_CREDENTIAL_KEY: undefined };
  const keyless = bindCredentials(createTenantDb(storeA.stub), storeA.tenantId, keylessEnv);
  const refused = await save(keyless, keylessEnv, "kunci-baru-tanpa-platform-key");
  assert.equal(refused.status, 503);
  assert.equal(stored(storeA), sealed, "no plaintext was written");
  assert.equal((await getProviderConfig(keyless)).mengantar.apiKey, "");
  assert.equal((await readReadiness(keyless)).mengantar, false);
});

test("T-48: the tenant maintenance run seals every legacy plaintext credential, and a second run changes nothing", async () => {
  const store = await readinessHarness("kunci-lama");
  store.sql.exec(`UPDATE stores SET mengantar_api_key = 'legacy-mengantar', autolaris_api_key = 'legacy-autolaris',
    meta_capi_token = 'legacy-meta', google_ads_developer_token = 'legacy-dev', google_ads_client_secret = 'legacy-client',
    google_ads_refresh_token = 'legacy-refresh'`);
  assert.equal((await getProviderConfig(store.database)).mengantar.apiKey, "legacy-mengantar", "legacy plaintext still reads while a key is present");
  const originalFetch = globalThis.fetch;
  const quiet = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  globalThis.fetch = (async () => Response.json({ success: true, data: [] })) as typeof fetch;
  console.log = console.info = console.warn = console.error = () => undefined;
  try {
    const run = () =>
      runTenantMaintenance(store.env as never, store.database, store.tenantId, Date.parse("2026-11-16T10:00:00Z"),
        { waitUntil() {}, passThroughOnException() {} } as never);
    await run();
    const row = store.sql.prepare(`SELECT ${STORE_CREDENTIAL_COLUMNS.join(", ")} FROM stores`).get() as Record<string, string>;
    for (const column of STORE_CREDENTIAL_COLUMNS) assert.match(row[column], /^enc:v1:/, `${column} sealed`);
    assert.doesNotMatch(JSON.stringify(row), /legacy-/, "no plaintext credential left in the store");
    await run();
    assert.deepEqual(store.sql.prepare(`SELECT ${STORE_CREDENTIAL_COLUMNS.join(", ")} FROM stores`).get(), row, "idempotent");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }
  assert.equal((await getProviderConfig(store.database)).autolaris.apiKey, "legacy-autolaris");
});

test("T-48: every tenant handle the platform creates carries the credential cipher", () => {
  // A handle made without it would read every credential as not set — or, if
  // someone 'fixed' that, serve them unsealed. Only bound creation sites exist.
  const root = new URL("../", import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(`${dir}${entry.name}/`) : [`${dir}${entry.name}`]);
  const unbound = walk(root)
    .filter((path) => /\.(ts|astro)$/.test(path) && !/\.test\.ts$|\/testing\/|tenant-db\.conformance\.ts$/.test(path))
    .flatMap((path) =>
      readFileSync(path, "utf8").split("\n").map((line, index) => ({ path: path.slice(root.length), line: line.trim(), index }))
        .filter(({ line }) => /createTenantDb\(/.test(line) && !/bindCredentials\(createTenantDb\(/.test(line) && !/export function createTenantDb/.test(line)))
    .map(({ path, index, line }) => `${path}:${index + 1} ${line}`);
  assert.deepEqual(unbound, []);
});

test("T-48: every credential saved through its own admin route is stored sealed, and no response echoes it (T-48 review)", async () => {
  const store = await readinessHarness("kunci-semua");
  store.sql.exec(`INSERT INTO plugins (id, enabled, schema_version, settings, updated_at) VALUES ('kelola', 1, 1, '{}', '2026-11-16');
    CREATE TABLE IF NOT EXISTS plugin_kelola_orders (order_id INTEGER PRIMARY KEY NOT NULL, synced_at TEXT, attempts INTEGER DEFAULT 0 NOT NULL, last_error TEXT, lead_synced_at TEXT);`);
  const locals = { admin: { username: "owner", role: "owner", mustChangePassword: false }, tenantDb: store.database, runtimeEnv: store.env };
  const call = async (route: { PUT: unknown; GET?: unknown }, path: string, body?: unknown) => {
    const handler = (body === undefined ? route.GET : route.PUT) as (context: unknown) => Promise<Response>;
    const response = await handler({
      request: new Request(`https://kunci-semua.adsbook.my.id${path}`, body === undefined ? {} : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      locals,
    });
    return { status: response.status, text: await response.text() };
  };
  const secrets = {
    mengantar: "mengantar-rahasia-semua-001",
    autolaris: "autolaris-rahasia-semua-002",
    meta: "EAAB-meta-rahasia-semua-003",
    developer: "google-dev-rahasia-semua-004",
    clientSecret: "google-client-rahasia-semua-005",
    refresh: "google-refresh-rahasia-semua-006",
    kelola: "kelola-rahasia-semua-0123456789",
  };
  const originalFetch = globalThis.fetch;
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  globalThis.fetch = (async () => new Response("{}", { status: 400 })) as typeof fetch;
  console.log = console.warn = console.error = console.info = () => undefined;
  const responses: string[] = [];
  try {
    const saves = [
      await call(adminSettingsRoute, "/api/admin/settings", { action: "save-integrations", integrations: {
        mengantar_api_key: secrets.mengantar, autolaris_api_key: secrets.autolaris,
        mengantar_base_url: "https://api-public.mengantar.com", autolaris_base_url: "https://api-h2h.autolaris.com",
        autolaris_order_origin_id: "1", autolaris_order_destination_id: "2" } }),
      await call(adminAdsRoute, "/api/admin/ads", { action: "save-meta", meta_pixel_id: "100000000000001", meta_capi_token: secrets.meta }),
      await call(adminAdsRoute, "/api/admin/ads", { action: "save-google-offline", google_offline: {
        customer_id: "123-456-7890", conversion_action_id: "987654", developer_token: secrets.developer,
        client_id: "client-id.apps.googleusercontent.com", client_secret: secrets.clientSecret, refresh_token: secrets.refresh } }),
      await call(kelolaAdminRoute, "/api/admin/plugins/kelola", { action: "save", webhook_url: "https://kelola.test/api/public/toko/order/twh_semua123", webhook_secret: secrets.kelola }),
    ];
    for (const save of saves) assert.equal(save.status, 200, save.text);
    responses.push(...saves.map((save) => save.text));
    const reads = [
      await call(adminSettingsRoute, "/api/admin/settings"),
      await call(adminAdsRoute, "/api/admin/ads"),
      await call(kelolaAdminRoute, "/api/admin/plugins/kelola"),
    ];
    for (const read of reads) assert.equal(read.status, 200, read.text);
    responses.push(...reads.map((read) => read.text));
    // Masks are made from the opened value, never from the stored envelope.
    const ads = JSON.parse(reads[1].text).data;
    assert.equal(ads.meta_capi_token_masked, maskSecretValue(secrets.meta));
    assert.equal(ads.google_offline.developer_token_masked, maskSecretValue(secrets.developer));
    assert.equal(ads.google_offline.configured, true);
    assert.equal(JSON.parse(reads[2].text).data.kelola.configured, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }
  const row = store.sql.prepare(`SELECT ${STORE_CREDENTIAL_COLUMNS.join(", ")} FROM stores`).get() as Record<string, string>;
  for (const column of STORE_CREDENTIAL_COLUMNS) assert.match(row[column] ?? "", /^enc:v1:/, `${column} stored sealed`);
  const plugin = (store.sql.prepare("SELECT settings FROM plugins WHERE id = 'kelola'").get() as { settings: string }).settings;
  assert.match(JSON.parse(plugin).webhook_secret, /^enc:v1:/);
  assert.equal(responses.some((text) => text.includes("enc:")), false, "no response carries a stored envelope");
  const everything = JSON.stringify(row) + plugin + responses.join("\n");
  for (const [name, secret] of Object.entries(secrets)) {
    assert.equal(everything.includes(secret), false, `${name}: never stored in plaintext, never in a response`);
  }
  // And every one of them opens for the code that needs it.
  assert.equal((await getProviderConfig(store.database)).mengantar.apiKey, secrets.mengantar);
  assert.equal((await getProviderConfig(store.database)).autolaris.apiKey, secrets.autolaris);
  assert.equal((await getStoreAdsConfig({ tenantDb: store.database } as never)).metaCapiToken, secrets.meta);
  assert.equal((await loadGoogleAdsOfflineConfig(store.database))?.refreshToken, secrets.refresh);
});

test("T-48: the real TenantStore.alarm binds the cipher and seals legacy plaintext, plugin secrets included (T-48 review)", async () => {
  const { TenantStore } = workerModule as unknown as { TenantStore: new (ctx: unknown, env: unknown) => { alarm(): Promise<void> } };
  const platformDb = await platform([["t-alarm", "active", "alarm.adsbook.my.id"]]);
  const storage = createNodeStorage();
  for (const file of CHAIN) applyMigrationFile(storage, file, splitMigrationStatements);
  storage.db.exec(`
    INSERT INTO stores (id, name, slug, created_at, mengantar_api_key, meta_capi_token) VALUES (1, 'Alarm', 't-alarm', '2026-11-16', 'legacy-mengantar-alarm', 'legacy-meta-alarm');
    INSERT INTO plugins (id, enabled, schema_version, settings, updated_at)
      VALUES ('kelola', 1, 1, '{"webhook_url":"https://kelola.test/api/public/toko/order/twh_alarm","webhook_secret":"legacy-kelola-alarm-secret"}', '2026-11-16');
    CREATE TABLE IF NOT EXISTS plugin_kelola_orders (order_id INTEGER PRIMARY KEY NOT NULL, synced_at TEXT, attempts INTEGER DEFAULT 0 NOT NULL, last_error TEXT, lead_synced_at TEXT);
  `);
  const kv = memoryKv();
  kv.put("tenant_id", "t-alarm");
  let alarmAt: number | null = null;
  const ctx = {
    storage: Object.assign(storage, {
      kv,
      getAlarm: async () => alarmAt,
      setAlarm: async (at: number) => void (alarmAt = at),
    }),
    blockConcurrencyWhile: async (run: () => Promise<void>) => run(),
    waitUntil: () => undefined,
    id: { name: "t-alarm" },
  };
  // The production env: no binding is made by this test; the object makes its own.
  const store = new TenantStore(ctx, { PLATFORM_DB: platformDb, ...TEST_CREDENTIAL_ENV });
  const originalFetch = globalThis.fetch;
  const quiet = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  globalThis.fetch = (async () => Response.json({ success: true, data: [] })) as typeof fetch;
  console.log = console.warn = console.error = console.info = () => undefined;
  try {
    await store.alarm();
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, quiet);
  }
  const row = storage.db.prepare("SELECT mengantar_api_key, meta_capi_token FROM stores").get() as Record<string, string>;
  assert.match(row.mengantar_api_key, /^enc:v1:/);
  assert.match(row.meta_capi_token, /^enc:v1:/);
  const settings = JSON.parse((storage.db.prepare("SELECT settings FROM plugins WHERE id = 'kelola'").get() as { settings: string }).settings);
  assert.match(settings.webhook_secret, /^enc:v1:/, "the maintenance run seals plugin secrets too");
  assert.doesNotMatch(JSON.stringify(row) + JSON.stringify(settings), /legacy-/);
  assert.notEqual(alarmAt, null, "the alarm re-armed itself");
});

test("Paduka 2026-11-16: the store's subdomain 301s to the active custom primary, keeps its APIs, webhooks and recovery, and serves again once the domain is removed", async () => {
  const platformDb = await platform([["m-r", "active", "tokodia.adsbook.my.id"]]);
  const stores = namespace({ migrated: true });
  stores.get("m-r").storage.db.exec("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko Dia', 'tokodia', '2026-11-16')");
  makeReady(stores.get("m-r").storage.db);
  platformDb.sqlite.exec(`
    UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = 'm-r';
    INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at) VALUES
      ('domain.com', 'm-r', 'custom', 'domain.com', 'active', 1, '2026-11-16'),
      ('www.domain.com', 'm-r', 'custom', 'domain.com', 'active', 0, '2026-11-16');`);
  const onRequest = createMiddleware();
  const ask = async (href: string, method = "GET") => {
    let reached = false;
    const original = { log: console.log, info: console.info, error: console.error };
    console.log = console.info = console.error = () => undefined;
    try {
      const request = new Request(href, method === "GET" ? {} : { method, headers: { "content-type": "application/json" }, body: "{}" });
      const response = (await onRequest(
        { request, url: new URL(href), params: {}, locals: { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...TEST_CREDENTIAL_ENV } }, routePattern: "/", redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }) } as never,
        (async () => ((reached = true), new Response("ok"))) as never,
      )) as Response;
      return { status: response.status, location: response.headers.get("location"), reached };
    } finally {
      Object.assign(console, original);
    }
  };
  assert.deepEqual(await ask("https://tokodia.adsbook.my.id/produk/x?fbclid=123"), { status: 301, location: "https://domain.com/produk/x?fbclid=123", reached: false });
  assert.deepEqual(await ask("https://www.domain.com/produk/x?fbclid=123"), { status: 301, location: "https://domain.com/produk/x?fbclid=123", reached: false });
  assert.equal((await ask("https://domain.com/produk/x?fbclid=123")).reached, true, "the primary serves");
  for (const [href, method] of [
    ["https://tokodia.adsbook.my.id/api/webhooks/autolaris/token-abc", "POST"],
    ["https://tokodia.adsbook.my.id/api/owner-recovery", "POST"],
    ["https://tokodia.adsbook.my.id/pemulihan", "GET"],
    ["https://tokodia.adsbook.my.id/hello", "GET"],
  ] as const) {
    assert.notEqual((await ask(href, method)).status, 301, `${method} ${href} stays on the subdomain`);
  }
  // The domain is removed (or replaced): the primary is the subdomain again and it serves, no loop.
  platformDb.sqlite.exec("UPDATE tenant_hosts SET status = 'revoked', is_primary = 0 WHERE tenant_id = 'm-r' AND kind = 'custom'; UPDATE tenant_hosts SET is_primary = 1 WHERE host = 'tokodia.adsbook.my.id'; UPDATE tenants SET cache_version = cache_version + 1 WHERE id = 'm-r'");
  const served = await ask("https://tokodia.adsbook.my.id/produk/x?fbclid=123");
  assert.equal(served.status, 200);
  assert.equal(served.reached, true, "the subdomain serves the store directly again");
});

test("ADR-041 (T-49): preview → grace → expired through the real middleware; sign-in and admin never close", async () => {
  const store = await readinessHarness("bayar-dulu", { preview: true });
  store.product();
  store.warehouse(1, 1, "ORIGIN-1", "pickup-1");
  store.mengantar();
  const platformDb = store.env.PLATFORM_DB as D1Database;
  const setEnds = (ends: number | null) =>
    platformDb
      .prepare("UPDATE tenants SET subscription_ends_at = ?, grace_ends_at = ? WHERE id = ?")
      .bind(ends === null ? null : new Date(ends).toISOString(), ends === null ? null : new Date(ends + 48 * 3_600_000).toISOString(), store.tenantId)
      .run();
  const hour = 3_600_000;
  const expectState = async (label: string, code: string | null) => {
    const page = await store.open("/produk/kopi");
    assert.equal(page.reached, true, `${label}: the storefront renders`);
    for (const [path, method] of [["/api/submit-order", "POST"], ["/api/submit-middle-order", "POST"], ["/api/record-abandoned-order", "POST"], ["/api/v1/checkout", "POST"], ["/api/shipping-rates", "GET"]] as const) {
      const response = await store.open(path, method);
      if (code) {
        assert.equal(response.status, 402, `${label} ${path}`);
        assert.equal(response.reached, false, `${label} ${path} reached its route`);
        assert.equal(JSON.parse(response.body).code, code);
      } else {
        assert.equal(response.reached, true, `${label} ${path}`);
      }
    }
    assert.equal(page.robots, code ? "noindex, nofollow" : null, `${label}: indexing`);
    // The owner's way in and the billing screen are never behind the subscription.
    assert.equal((await store.open("/hello")).reached, true, `${label} /hello`);
    for (const path of ["/admin", "/admin/billing", "/api/admin/billing"]) {
      const response = await store.open(path);
      assert.ok(response.status === 302 || response.status === 401, `${label} ${path} → ${response.status}`);
    }
  };
  await expectState("preview", "SUBSCRIPTION_REQUIRED");
  await setEnds(Date.now() + 10 * 24 * hour);
  await expectState("subscribed", null);
  await setEnds(Date.now() - hour);
  await expectState("grace", null);
  await setEnds(Date.now() - 49 * hour);
  await expectState("expired", "SUBSCRIPTION_EXPIRED");
});

test("T-50/BILL-7: only platform_owner grants subscription days; the grant needs a reason, is audited, and opens checkout", async () => {
  const { platformDb, run } = await platformHarness();
  const tenant = await run("diberi-hari");
  assert.ok(tenant.status === 201);
  if (tenant.status !== 201) return;
  const support = { id: "pu_s", email: "support@ops.example", role: "platform_support" as const };
  const owner = { id: "pu_o", email: "owner@ops.example", role: "platform_owner" as const };
  const ends = () => (platformDb.sqlite.prepare("SELECT subscription_ends_at AS e FROM tenants WHERE id = ?").get(tenant.tenantId) as { e: string | null }).e;
  const refused = await runTenantAction(platformDb, support, tenant.tenantId, "grant-subscription", { days: 30, reason: "pilot Saraku" });
  assert.equal(refused.ok || refused.status, 403);
  assert.equal(ends(), null, "a support grant changes nothing");
  assert.equal((await runTenantAction(platformDb, owner, tenant.tenantId, "grant-subscription", { days: 30, reason: "" })).ok, false);
  const granted = await runTenantAction(platformDb, owner, tenant.tenantId, "grant-subscription", { days: 30, reason: "pilot Saraku" });
  assert.ok(granted.ok);
  assert.ok(ends() && Date.parse(ends()!) > Date.now() + 29 * 86_400_000);
  const audit = platformDb.sqlite.prepare("SELECT actor, detail_json FROM tenant_events WHERE tenant_id = ? AND kind = 'subscription_granted'").all(tenant.tenantId) as { actor: string; detail_json: string }[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "platform:pu_o");
  assert.equal(JSON.parse(audit[0].detail_json).reason, "pilot Saraku");
});

// ------------------------------------------------ Register UX & Flow ----

test("UX-1: suggestFreeSlugs returns 3 valid, unreserved, unclaimed alternatives", async () => {
  const { suggestFreeSlugs } = await import("./slugs.ts");
  const { platformDb } = await signupHarness();
  platformDb.sqlite
    .prepare("INSERT INTO tenants (id, slug, owner_email, status, plan_id, created_at) VALUES ('t1', 'herbal', 'a@b.co', 'active', 'pilot', '2026-11-16'), ('t2', 'herbal-id', 'b@b.co', 'active', 'pilot', '2026-11-16')")
    .run();
  const suggestions = await suggestFreeSlugs(platformDb, "herbal", 3);
  assert.deepEqual(suggestions, ["herbal-official", "herbal-store", "herbal-shop"]);
  const reserved = await suggestFreeSlugs(platformDb, "admin", 3);
  assert.equal(reserved.length, 3);
  assert.equal(reserved.includes("admin"), false);
});

test("UX-1: optional WhatsApp at signup seeds store CS WhatsApp & owner_whatsapp, and 409 returns 3 suggestions", async () => {
  const { planSignup } = await import("./signup.ts");
  const badWa = planSignup({
    storeName: "Toko Uji",
    slug: "toko-wa-salah",
    email: "owner@wa.example",
    whatsapp: "12345",
    password: "password-aman-123",
    terms: true,
  });
  assert.equal(badWa.ok, false);
  if (!badWa.ok) assert.ok(badWa.errors.whatsapp);

  const { platformDb, stores, env } = await signupHarness();
  const created = await signup(
    env,
    {
      storeName: "Herbal Segar",
      slug: "herbal-segar",
      email: "owner@herbalsegar.id",
      whatsapp: "0812-3456-7890",
      password: "password-aman-123",
      terms: true,
      turnstileToken: "ok",
    },
    "203.0.113.77",
    { verifyTurnstile: async () => true },
  );
  assert.equal(created.status, 201);
  if (created.status !== 201) return;
  assert.equal(created.whatsapp, "6281234567890");
  const row = platformDb.sqlite.prepare("SELECT owner_whatsapp FROM tenants WHERE id = ?").get(created.tenantId) as { owner_whatsapp: string | null };
  assert.equal(row.owner_whatsapp, "6281234567890");

  const tenantDb = createTenantDb(stores.get(created.tenantId).stub);
  const storeRow = await tenantDb.prepare("SELECT support_whatsapp FROM stores LIMIT 1").first<{ support_whatsapp: string | null }>();
  assert.equal(storeRow?.support_whatsapp, "6281234567890");
  const rotator = await tenantDb.prepare("SELECT phone, is_active FROM whatsapp_numbers LIMIT 1").first<{ phone: string; is_active: number }>();
  assert.deepEqual({ ...rotator }, { phone: "6281234567890", is_active: 1 });

  const taken = await signup(
    env,
    {
      storeName: "Herbal Segar",
      slug: "herbal-segar",
      email: "other@herbalsegar.id",
      password: "password-aman-123",
      terms: true,
      turnstileToken: "ok",
    },
    "203.0.113.78",
    { verifyTurnstile: async () => true },
  );
  assert.equal(taken.status, 409);
  assert.equal(taken.suggestions?.length, 3);
});

test("IAM-8: resolveHandoffTarget routes new owners to /admin/setup or /admin/billing?cycle= and blocks open redirects", async () => {
  const { resolveHandoffTarget } = await import("../pages/api/handoff.ts");
  assert.equal(resolveHandoffTarget(undefined), "/admin/dashboard");
  assert.equal(resolveHandoffTarget("/admin/setup?welcome=1"), "/admin/setup?welcome=1");
  assert.equal(resolveHandoffTarget("/admin/billing?cycle=12m"), "/admin/billing?cycle=12m");
  assert.equal(resolveHandoffTarget("/admin/dashboard"), "/admin/dashboard");
  assert.equal(resolveHandoffTarget("https://evil.example"), "/admin/dashboard");
  assert.equal(resolveHandoffTarget("//evil.example"), "/admin/dashboard");
});

