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
const { getAdminCredential, verifyAdminLoginPassword, validateAdminUsername } = await import("../lib/admin-credentials.ts");
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
      runTenantMaintenance({ PLATFORM_DB: platformDb, TENANT_STORE: stores.binding, ...env } as never, createTenantDb(stub), tenantId, time,
        { waitUntil() {}, passThroughOnException() {} } as never, primaryHost),
    setAlarm: async (at) => void stores.alarms.set(id, at),
  });
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
test("T-24: the cron migrates quiet tenants (bookmark first), arms each active tenant's alarm, isolates a failing one", async () => {
  const platformDb = await platform([
    ["c-a", "active", "cron-a.belanja.cc"],
    ["c-b", "active", "cron-b.belanja.cc"],
    ["c-c", "suspended", "cron-c.belanja.cc"],
    ["c-d", "active", "cron-d.belanja.cc"],
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
      { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } as never,
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
  const platformDb = await platform(ids.map((id) => [id, "active", `${id}.belanja.cc`] as [string, string, string]));
  platformDb.sqlite.prepare("UPDATE tenants SET schema_version = ?").run(CHAIN.length);
  const stores = namespace();
  const original = { error: console.error, info: console.info };
  console.error = console.info = () => undefined;
  const armedPerRun: number[] = [];
  try {
    for (let hour = 0; hour < 3; hour += 1) {
      const before = stores.asked.length;
      const result = await runPlatformCron(
        { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } as never,
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
  const platformDb = await platform(ids.map((id) => [id, "active", `${id}.belanja.cc`] as [string, string, string]));
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
  const platformDb = await platform([["m-1", "active", "mig-1.belanja.cc"], ["m-2", "suspended", "mig-2.belanja.cc"]]);
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
    assert.deepEqual(result, { migrated: ["p-a"], armed: 1, failed: [] });
    assert.equal(await fireAlarm(stores, platformDb as never, "p-a", { ...EVERY_PLATFORM_PROVIDER_ENV }, Date.parse("2026-11-16T05:07:00.000Z")), "ran");
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(calls, [], "a tenant without settings made an outbound provider call");
});

test("T-22/ISO-11: a cookie set from tenant A's host for the parent domain never stands in for a session on tenant B", async () => {
  const platformDb = await platform([["x-a", "active", "fix-a.belanja.cc"], ["x-b", "active", "fix-b.belanja.cc"]]);
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
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } };
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

  // What a script on A can plant for `.belanja.cc`: any name but a `__Host-` one.
  const planted = `adsbook_session=${tokens["x-a"]}; __host-adsbook_session=${tokens["x-a"]}`;
  assert.equal((await send("fix-b.belanja.cc", { cookie: planted })).status, 401, "a planted parent-domain cookie opened B");
  const intact = await send("fix-b.belanja.cc", { cookie: `${planted}; ${SESSION_COOKIE_NAME}=${tokens["x-b"]}` });
  assert.equal(intact.status, 200, "B's own session survives the planted cookies");
  assert.match(intact.text, /INV-X-B/);
  assert.doesNotMatch(intact.text, /INV-X-A/);
  // SEC-3: the admin answer carries the admin policy and no seller tag host.
  assert.equal(intact.csp, "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  assert.doesNotMatch(intact.csp ?? "", /googletagmanager|facebook|tiktok|doubleclick/);

  // IAM-5 on an unsafe admin route, with B's valid session in every case.
  const bCookie = `${SESSION_COOKIE_NAME}=${tokens["x-b"]}`;
  const post = (headers: Record<string, string>) => send("fix-b.belanja.cc", { method: "POST", cookie: bCookie, headers });
  const sameSiteCrossHost = await post({ origin: "https://fix-a.belanja.cc", "sec-fetch-site": "same-site" });
  assert.equal(sameSiteCrossHost.status, 403, "a same-site cross-host POST was accepted");
  assert.equal(JSON.parse(sameSiteCrossHost.text).code, "forbidden_origin");
  assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 403, "a POST without Origin was accepted");
  const oldBrowser = await post({ origin: "https://fix-b.belanja.cc" });
  assert.equal(oldBrowser.status, 403);
  assert.deepEqual(JSON.parse(oldBrowser.text), {
    success: false,
    error: "Browser ini terlalu lama untuk menyimpan perubahan dengan aman. Perbarui browser Anda, lalu coba lagi.",
    code: "browser_unsupported",
  });
  const sameOrigin = await post({ origin: "https://fix-b.belanja.cc", "sec-fetch-site": "same-origin" });
  assert.notEqual(sameOrigin.status, 403, "a same-origin POST from a current browser was refused");

  // IAM-5 covers admin pages too, not only /api/admin (T-22 review).
  const pageHref = "https://fix-b.belanja.cc/admin/profile";
  const pageRequest = new Request(pageHref, { method: "POST", headers: { cookie: bCookie, "sec-fetch-site": "same-site", origin: "https://fix-a.belanja.cc" } });
  const pageContext = { request: pageRequest, url: new URL(pageHref), locals: { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } }, routePattern: "/admin/profile", redirect: () => new Response(null, { status: 302 }) };
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
  const platformDb = await platform([["w-a", "active", "hook-a.belanja.cc"], ["w-b", "active", "hook-b.belanja.cc"]]);
  platformDb.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES ('shop-a.example', 'w-a', 'custom', 'active', 0, '2026-11-16')").run();
  const stores = namespace({ migrated: true });
  for (const id of ["w-a", "w-b"]) {
    stores.get(id).storage.db.exec(`INSERT INTO stores (id, name, slug, created_at) VALUES (1, '${id}', '${id}', '2026-11-16')`);
  }
  const tokenA = await issueWebhookToken(platformDb, "w-a", "autolaris");
  const tokenB = await issueWebhookToken(platformDb, "w-b", "autolaris");
  const onRequest = createMiddleware();
  const call = async (host: string, token: string) => {
    const href = `https://${host}/api/webhooks/autolaris/${token}`;
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } };
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

  assert.equal(await call("hook-a.belanja.cc", "0".repeat(64)), 401, "a wrong token");
  assert.equal(await call("hook-a.belanja.cc", "not-a-token"), 401, "a malformed token");
  assert.equal(await call("hook-a.belanja.cc", tokenB), 401, "tenant B's token on tenant A's host");
  assert.equal(await call("shop-a.example", tokenA), 404, "A's own token on A's custom domain");
  assert.deepEqual(writes(), [0, 0], "a refused webhook wrote evidence");
  assert.deepEqual(changes(), before, "a refused webhook changed a row (rate limit, store or control plane)");

  assert.equal(await call("hook-a.belanja.cc", tokenA), 200);
  assert.deepEqual(writes(), [1, 0], "the accepted call recorded for its own tenant only");

  // A rotated token stops the old one at once.
  const rotated = await issueWebhookToken(platformDb, "w-a", "autolaris");
  assert.equal(await call("hook-a.belanja.cc", tokenA), 401);
  assert.equal(await call("hook-a.belanja.cc", rotated), 200);
  assert.deepEqual(writes(), [2, 0]);
});

test("T-25: a custom primary moves indexing off the subdomain; the probe answers the tenant; a pending host never reaches tenant code", async () => {
  const platformDb = await platform([["d-a", "active", "dom-a.belanja.cc"]]);
  platformDb.sqlite.exec(`
    UPDATE tenant_hosts SET is_primary = 0 WHERE host = 'dom-a.belanja.cc';
    INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at)
      VALUES ('tokoa.com', 'd-a', 'custom', 'tokoa.com', 'active', 1, '2026-11-16'),
             ('baru.com', 'd-a', 'custom', 'baru.com', 'pending', 0, '2026-11-16');
  `);
  const stores = namespace({ migrated: true });
  stores.get("d-a").storage.db.exec("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko A', 'toko-a', '2026-11-16')");
  const onRequest = createMiddleware();
  const visit = async (host: string, path = "/") => {
    const href = `https://${host}${path}`;
    let reached = false;
    let siteUrl = "";
    const locals: Record<string, unknown> = { runtimeEnv: { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } };
    const context = { request: new Request(href), url: new URL(href), locals, routePattern: path, redirect: () => new Response(null, { status: 302 }) };
    const previous = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const response = (await onRequest(context as never, (async () => {
        reached = true;
        siteUrl = (locals.tenant as { siteUrl: string }).siteUrl;
        return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
      }) as never)) as Response;
      return { status: response.status, robots: response.headers.get("x-robots-tag"), text: await response.text(), reached, siteUrl };
    } finally {
      Object.assign(console, previous);
    }
  };
  const sub = await visit("dom-a.belanja.cc");
  assert.equal(sub.robots, "noindex, nofollow", "the subdomain competes with the custom primary");
  assert.equal(sub.siteUrl, "https://tokoa.com", "canonical URLs follow the primary host");
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

// ---------------------------------------------------------------- T-26 ----

/** A signup harness: one control plane, one store namespace, Turnstile passing. */
async function signupHarness() {
  const platformDb = await platform([]);
  const stores = namespace();
  const env = { PLATFORM_DB: platformDb, TENANT_STORE: stores.binding } as Record<string, unknown>;
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
  assert.equal(result.host, "toko-baru.belanja.cc");
  const row = platformDb.sqlite.prepare("SELECT status, schema_version FROM tenants WHERE id = ?").get(result.tenantId) as { status: string; schema_version: number };
  assert.deepEqual({ ...row }, { status: "active", schema_version: CHAIN.length });
  const host = platformDb.sqlite.prepare("SELECT status, is_primary, kind FROM tenant_hosts WHERE host = 'toko-baru.belanja.cc'").get() as object;
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
      const href = `https://gagal-${step}.belanja.cc/hello`;
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

  assert.equal((await redeem("serah-b.belanja.cc", a.handoffToken)).status, 401, "A's token on B's host");
  assert.equal((await redeem("serah-a.belanja.cc", a.handoffToken, { origin: "https://serah-b.belanja.cc", "sec-fetch-site": "same-site" })).status, 401, "posted from another seller host");
  assert.equal((await redeem("serah-a.belanja.cc", a.handoffToken, { "sec-fetch-site": "cross-site" })).status, 401, "no Origin");
  const first = await redeem("serah-a.belanja.cc", a.handoffToken);
  assert.equal(first.status, 303);
  assert.equal(first.location, "/admin/dashboard");
  assert.ok(first.cookie?.value);
  assert.equal(first.cookie?.options.secure, true);
  assert.equal(first.cookie?.options.path, "/");
  assert.equal("domain" in (first.cookie?.options ?? {}), false);
  assert.equal((await redeem("serah-a.belanja.cc", a.handoffToken)).status, 401, "replay");

  const recovery = await issueHandoff(platformDb, a.tenantId, "serah-a.belanja.cc", "owner_recovery");
  assert.equal((await redeem("serah-a.belanja.cc", recovery)).status, 401, "wrong purpose");
  const expired = await issueHandoff(platformDb, a.tenantId, "serah-a.belanja.cc", "signup", new Date(Date.now() - 11 * 60_000));
  assert.equal((await redeem("serah-a.belanja.cc", expired)).status, 401, "expired");

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
  const forged = prepareHandoffRequest(new Request("https://toko.belanja.cc/api/handoff", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      [HANDOFF_ORIGIN_HEADER]: "https://app.adsbook.id",
      "x-adsbook-handoff-fetch-site": "cross-site",
    },
  }));
  assert.equal(forged.headers.get(HANDOFF_ORIGIN_HEADER), "https://evil.example", "a client-sent copy is replaced");
  assert.equal(forged.headers.get("origin"), "https://toko.belanja.cc");
  assert.equal(forged.headers.get("sec-fetch-site"), "same-origin", "presented as same-origin to Astro only");
  const noOrigin = prepareHandoffRequest(new Request("https://toko.belanja.cc/api/handoff", { method: "POST", headers: { [HANDOFF_ORIGIN_HEADER]: "https://app.adsbook.id" } }));
  assert.equal(noOrigin.headers.get(HANDOFF_ORIGIN_HEADER), null, "no Origin, no carried origin");
  assert.equal(noOrigin.headers.get("x-adsbook-handoff-fetch-site"), null, "a client-sent fetch-site copy is dropped");
  const other = new Request("https://toko.belanja.cc/api/admin/orders", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(prepareHandoffRequest(other), other, "every other path keeps Astro's check");
});
