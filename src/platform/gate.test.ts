// T-17: the control plane, the request gate and the request log line.
// Tests ISO-1, ISO-2, HOST-1, HOST-3 (docs/spec/06, 08) run on the real
// control-plane chain in node:sqlite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import type { MigrationSource } from "../lib/schema-version.ts";
import {
  bumpTenantCacheVersion,
  decideHost,
  ensureControlPlane,
  HOST_CACHE_TTL_MS,
  HOST_QUARANTINE_MS,
  HostCache,
  PLATFORM_SCHEMA_VERSION,
} from "./control-plane.ts";
import { gateRequest, type GateResult } from "./gate.ts";
import { isValidationPath, normalizeHost, platformHosts } from "./host.ts";
import { buildRequestLog, routeLabel, writeRequestLog } from "./request-log.ts";
import { statePage } from "./state-pages.ts";
import { createSqliteD1, type SqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN: MigrationSource[] = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

const T0 = Date.parse("2026-11-16T03:00:00.000Z");

async function controlPlane(): Promise<SqliteD1> {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  return db;
}

function addTenant(db: SqliteD1, id: string, slug: string, status = "active") {
  db.sqlite
    .prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, slug, `${slug}@example.test`, status, "2026-11-16T00:00:00.000Z");
}

function addHost(db: SqliteD1, host: string, tenantId: string, status = "active", primary = 1, quarantineUntil: string | null = null) {
  db.sqlite
    .prepare(
      `INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, quarantine_until, created_at)
       VALUES (?, ?, 'subdomain', ?, ?, ?, '2026-11-16T00:00:00.000Z')`,
    )
    .run(host, tenantId, status, primary, quarantineUntil);
}

const noSchema = async () => undefined;

async function gate(db: SqliteD1 | null, href: string, options: { headers?: Record<string, string>; now?: number; cache?: HostCache; extraPlatform?: string } = {}) {
  const request = new Request(href, { headers: options.headers });
  const passed: Request[] = [];
  const result = await gateRequest(
    request,
    new URL(href),
    { PLATFORM_DB: db ?? undefined, PLATFORM_HOSTS: options.extraPlatform },
    {
      now: new Date(options.now ?? T0),
      cache: options.cache ?? new HostCache(),
      ensureSchema: noSchema,
      passThrough: async (forwarded) => {
        passed.push(forwarded);
        return new Response("validation", { status: 200 });
      },
    },
  );
  return { result, passed };
}

const tenantOf = (result: GateResult) => (result.kind === "tenant" ? result.tenant.tenantId : null);
const statusOf = (result: GateResult) => (result.kind === "refused" || result.kind === "validation" ? result.response.status : 200);

test("the control-plane chain creates every table of the data model, with the pilot plan", async () => {
  const db = await controlPlane();
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(tables, [
    "handoff_tokens",
    "migration_bookmarks",
    "operator_notices",
    "plans",
    "platform_credential_grants",
    "platform_identities",
    "platform_sessions",
    "platform_users",
    "purge_sweeps",
    "rate_limits",
    "shared_mengantar_areas",
    "signup_email_challenges",
    "subscription_invoices",
    "tenant_events",
    "tenant_health",
    "tenant_hosts",
    "tenant_usage_daily",
    "tenants",
    "webhook_secrets",
  ]);
  assert.equal(CHAIN.length, PLATFORM_SCHEMA_VERSION);
  assert.deepEqual({ ...db.sqlite.prepare("SELECT id, max_custom_domains FROM plans").get() }, { id: "pilot", max_custom_domains: 1 });
});

test("a host is owned once, a tenant has one primary, and hosts are stored normalised (DATA-2, DATA-6)", async () => {
  const db = await controlPlane();
  addTenant(db, "t-a", "toko-a");
  addTenant(db, "t-b", "toko-b");
  addHost(db, "toko-a.adsbook.my.id", "t-a");
  assert.throws(() => addHost(db, "toko-a.adsbook.my.id", "t-b"), /UNIQUE constraint failed: tenant_hosts.host/);
  assert.throws(() => addHost(db, "toko-a-2.adsbook.my.id", "t-a", "active", 1), /UNIQUE constraint failed/);
  assert.throws(() => addHost(db, "Toko-B.adsbook.my.id", "t-b"), /CHECK constraint failed/);
  assert.throws(() => addHost(db, "toko-b.adsbook.my.id.", "t-b"), /CHECK constraint failed/);
  assert.throws(() => addTenant(db, "t-c", "toko-c", "deleted"), /CHECK constraint failed/);
  const fresh = new Date().toISOString();
  db.sqlite.exec(`INSERT INTO tenant_events (tenant_id, kind, actor, at) VALUES ('t-a', 'signup', 'owner', '${fresh}'), ('t-a', 'old', 'owner', '2024-01-01T00:00:00.000Z')`);
  assert.throws(() => db.sqlite.exec("UPDATE tenant_events SET kind = 'x'"), /append-only/);
  assert.throws(() => db.sqlite.exec("DELETE FROM tenant_events WHERE kind = 'signup'"), /append-only/);
  db.sqlite.exec("DELETE FROM tenant_events WHERE kind = 'old'"); // the 1-year retention job (PRIV-4)
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenant_events").get()?.n, 1);
});

test("HOST-1: certificate validation passes through for unknown, pending and platform hosts, with no tenant work", async () => {
  const db = await controlPlane();
  addTenant(db, "t-p", "toko-p", "provisioning");
  addHost(db, "pending.example.com", "t-p", "pending", 0);
  for (const href of [
    "https://unknown.example.org/.well-known/acme-challenge/abc",
    "https://pending.example.com/.well-known/pki-validation/fileauth.txt",
    "https://adsbook.id/.well-known/acme-challenge/xyz",
  ]) {
    const before = db.queries.length;
    const { result, passed } = await gate(db, href);
    assert.equal(result.kind, "validation", href);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].url, href, "forwarded unmodified");
    assert.equal(db.queries.length, before, "no control-plane query");
  }
  assert.equal(isValidationPath("/.well-known/cf-custom-hostname-challenge/x"), false, "pre-validation is not ours to serve");
});

test("every host state answers before any tenant work: only an active host of an active tenant resolves", async () => {
  const db = await controlPlane();
  const cases: Array<[string, string, string, number, string | null]> = [
    ["active.adsbook.my.id", "active", "active", 200, "t-active"],
    ["pending.adsbook.my.id", "active", "pending", 404, null],
    ["revoked.adsbook.my.id", "active", "revoked", 404, null],
    ["provisioning.adsbook.my.id", "provisioning", "active", 404, null],
    ["purging.adsbook.my.id", "purging", "active", 404, null],
    ["purged.adsbook.my.id", "purged", "active", 404, null],
    ["suspended.adsbook.my.id", "suspended", "active", 403, null],
    ["recovery.adsbook.my.id", "recovery", "active", 503, null],
  ];
  for (const [host, tenantStatus, hostStatus] of cases) {
    const id = `t-${host.split(".")[0]}`;
    addTenant(db, id, id.slice(2), tenantStatus);
    addHost(db, host, id, hostStatus);
  }
  for (const [host, , , status, tenant] of cases) {
    const { result } = await gate(db, `https://${host}/produk/x`);
    assert.equal(statusOf(result), status, host);
    assert.equal(tenantOf(result), tenant, host);
  }
  const unknown = await gate(db, "https://nobody.adsbook.my.id/");
  assert.equal(statusOf(unknown.result), 404);
});

test("normalisation: case, port and trailing dot resolve the same tenant; malformed hosts never query", async () => {
  const db = await controlPlane();
  addTenant(db, "t-a", "toko-a");
  addHost(db, "toko-a.adsbook.my.id", "t-a");
  for (const href of ["https://TOKO-A.Adsbook.MY.ID/", "https://toko-a.adsbook.my.id:8443/", "https://toko-a.adsbook.my.id./"]) {
    assert.equal(tenantOf((await gate(db, href)).result), "t-a", href);
  }
  assert.equal(normalizeHost("toko-a.adsbook.my.id:8443"), "toko-a.adsbook.my.id");
  for (const raw of ["127.0.0.1", "[::1]:8080", "a b.example", "toko\u0000.adsbook.my.id", `${"a".repeat(64)}.example`, `${"abc.".repeat(64)}cc`, "-x.example", "x..example", ""]) {
    assert.equal(normalizeHost(raw), null, JSON.stringify(raw));
  }
  const before = db.queries.length;
  assert.equal(statusOf((await gate(db, "https://127.0.0.1/")).result), 404);
  assert.equal(db.queries.length, before, "an IP literal is refused without a query");
});

test("ISO-1: forwarded-host headers never select a tenant", async () => {
  const db = await controlPlane();
  addTenant(db, "t-a", "toko-a");
  addTenant(db, "t-b", "toko-b");
  addHost(db, "toko-a.adsbook.my.id", "t-a");
  addHost(db, "toko-b.adsbook.my.id", "t-b");
  const { result } = await gate(db, "https://toko-a.adsbook.my.id/admin", {
    headers: {
      "x-forwarded-host": "toko-b.adsbook.my.id",
      forwarded: "host=toko-b.adsbook.my.id",
      "x-original-host": "toko-b.adsbook.my.id",
      "x-host": "toko-b.adsbook.my.id",
    },
  });
  assert.equal(tenantOf(result), "t-a");
});

test("ISO-2 / HOST-3: a host moved from A to B is quarantined at once, then serves B and never A again", async () => {
  const db = await controlPlane();
  const cache = new HostCache();
  addTenant(db, "t-a", "toko-a");
  addTenant(db, "t-b", "toko-b");
  addHost(db, "shop.merchant.com", "t-a", "active", 0);
  // Warm isolate: A's mapping is in the in-isolate cache.
  assert.equal(tenantOf((await gate(db, "https://shop.merchant.com/", { cache, now: T0 })).result), "t-a");
  // Move: revoke, then claim for B with the quarantine (DOM-3).
  const moved = T0 + 1_000;
  db.sqlite
    .prepare("UPDATE tenant_hosts SET tenant_id = 't-b', status = 'active', revoked_at = NULL, quarantine_until = ? WHERE host = 'shop.merchant.com'")
    .run(new Date(moved + HOST_QUARANTINE_MS).toISOString());
  // Immediately and throughout the quarantine, in the same warm isolate: neither tenant.
  for (const offset of [1, HOST_CACHE_TTL_MS + 1, HOST_QUARANTINE_MS - 1]) {
    const during = await gate(db, "https://shop.merchant.com/", { cache, now: moved + offset });
    assert.equal(statusOf(during.result), 404, `offset ${offset}`);
  }
  // After the quarantine: never A; B once a miss cached during the quarantine
  // has expired (at most one cache TTL later).
  for (const offset of [HOST_QUARANTINE_MS + 1, HOST_QUARANTINE_MS + HOST_CACHE_TTL_MS + 2, HOST_QUARANTINE_MS * 3]) {
    const after = tenantOf((await gate(db, "https://shop.merchant.com/", { cache, now: moved + offset })).result);
    assert.notEqual(after, "t-a", `offset ${offset}`);
    if (offset >= HOST_QUARANTINE_MS + HOST_CACHE_TTL_MS) assert.equal(after, "t-b", `offset ${offset}`);
  }
  assert.ok(HOST_QUARANTINE_MS > HOST_CACHE_TTL_MS);
});

test("a suspension or revocation takes effect on the very next request in a warm isolate", async () => {
  const db = await controlPlane();
  const cache = new HostCache();
  addTenant(db, "t-a", "toko-a");
  addHost(db, "toko-a.adsbook.my.id", "t-a");
  assert.equal(tenantOf((await gate(db, "https://toko-a.adsbook.my.id/", { cache })).result), "t-a");
  db.sqlite.exec("UPDATE tenants SET status = 'suspended' WHERE id = 't-a'");
  assert.equal(statusOf((await gate(db, "https://toko-a.adsbook.my.id/", { cache, now: T0 + 1 })).result), 403);
  db.sqlite.exec("UPDATE tenants SET status = 'active' WHERE id = 't-a'");
  assert.equal(tenantOf((await gate(db, "https://toko-a.adsbook.my.id/", { cache, now: T0 + 2 })).result), "t-a");
  db.sqlite.exec("UPDATE tenant_hosts SET status = 'revoked' WHERE host = 'toko-a.adsbook.my.id'");
  assert.equal(statusOf((await gate(db, "https://toko-a.adsbook.my.id/", { cache, now: T0 + 3 })).result), 404);
});

test("the default pass-through answers 404 on local and IP hosts instead of fetching itself", async () => {
  const previous = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: Request) => (fetched.push(input.url), new Response("upstream"))) as typeof fetch;
  try {
    for (const href of [
      "http://127.0.0.1:8787/.well-known/acme-challenge/x",
      "http://[::1]:8787/.well-known/acme-challenge/x",
      "http://localhost:8787/.well-known/pki-validation/x",
      "http://toko.localhost:8787/.well-known/acme-challenge/x",
    ]) {
      const result = await gateRequest(new Request(href), new URL(href), {}, {});
      assert.equal(result.kind === "validation" && result.response.status, 404, href);
    }
    assert.deepEqual(fetched, []);
    const live = await gateRequest(new Request("https://shop.merchant.com/.well-known/acme-challenge/t"), new URL("https://shop.merchant.com/.well-known/acme-challenge/t"), {}, {});
    assert.equal(live.kind === "validation" && (await live.response.text()), "upstream");
    assert.deepEqual(fetched, ["https://shop.merchant.com/.well-known/acme-challenge/t"]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("platform routes are refused on tenant hosts, and tenant routes on platform hosts", async () => {
  const db = await controlPlane();
  addTenant(db, "t-a", "toko-a");
  addHost(db, "toko-a.adsbook.my.id", "t-a");
  assert.deepEqual([...platformHosts("platform.localhost, BAD HOST")].sort(), ["adsbook.id", "app.adsbook.id", "platform.localhost"]);
  const before = db.queries.length;
  for (const path of ["/admin/orders", "/api/v1/products", "/produk/x"]) {
    const { result } = await gate(db, `https://adsbook.id${path}`);
    assert.equal(statusOf(result), 404, path);
    assert.equal(result.kind === "refused" && result.hostKind, "platform");
  }
  // T-40: the marketing site's public paths are platform routes on a platform host.
  assert.equal((await gate(db, "https://adsbook.id/")).result.kind, "platform");
  assert.equal((await gate(db, "https://adsbook.id/harga")).result.kind, "platform");
  assert.equal(db.queries.length, before, "a platform host never queries tenant hosts");
  assert.equal((await gate(db, "https://app.adsbook.id/platform/admin")).result.kind, "platform");
  assert.equal((await gate(db, "https://platform.localhost:8787/platform/x", { extraPlatform: "platform.localhost" })).result.kind, "platform");
  assert.equal(statusOf((await gate(db, "https://toko-a.adsbook.my.id/platform/admin")).result), 404);
});

test("a random-Host flood writes nothing to KV and the in-isolate cache stays bounded", async () => {
  const db = await controlPlane();
  const cache = new HostCache(HOST_CACHE_TTL_MS, 100);
  const kvWrites: string[] = [];
  const env = {
    PLATFORM_DB: db,
    SESSION: { put: async (key: string) => void kvWrites.push(key), get: async () => null },
  };
  for (let i = 0; i < 500; i += 1) {
    const href = `https://r${i}-${Math.random().toString(36).slice(2, 8)}.example.com/`;
    const result = await gateRequest(new Request(href), new URL(href), env, { cache, ensureSchema: noSchema, now: new Date(T0) });
    assert.equal(statusOf(result), 404);
  }
  assert.deepEqual(kvWrites, []);
  assert.ok(cache.size <= 100, `cache grew to ${cache.size}`);
});

test("a control-plane failure is a 503 for the tenant host, never a default tenant", async () => {
  const db = await controlPlane();
  db.failWhen = /FROM tenant_hosts/;
  const { result } = await gate(db, "https://toko-a.adsbook.my.id/");
  assert.equal(statusOf(result), 503);
  assert.equal(result.kind === "refused" && result.reason, "platform_db_failed");
  const unbound = (await gate(null, "https://toko-a.adsbook.my.id/")).result;
  assert.equal(statusOf(unbound), 503);
  assert.equal(unbound.kind === "refused" && unbound.reason, "platform_db_unbound");
});

test("UX-5: state pages carry the right status, noindex, no store data, and one body for every unknown host", async () => {
  for (const [kind, status] of [["not-found", 404], ["suspended", 403], ["recovery", 503]] as const) {
    const page = statePage(kind, "/produk/x");
    assert.equal(page.status, status);
    assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const body = await page.text();
    assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
    assert.doesNotMatch(body, /adsbook|platform|admin|href=/i, "no platform link and no store data");
  }
  const api = statePage("suspended", "/api/v1/products");
  assert.equal(api.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(((await api.json()) as { code: string }).code, "STORE_SUSPENDED");
  const db = await controlPlane();
  const a = (await gate(db, "https://one.example.com/x")).result;
  const b = (await gate(db, "https://two.example.net/y")).result;
  assert.equal(
    a.kind === "refused" ? await a.response.text() : "",
    b.kind === "refused" ? await b.response.text() : "-",
    "no host enumeration through the 404 body",
  );
  assert.equal(decideHost(null, "x", new Date(T0)).kind, "not-found");
});

test("OBS-1: the request log carries the route pattern, never a path token or a query string", () => {
  const lines: string[] = [];
  for (const [pattern, fallback] of [
    ["/api/webhooks/[provider]/[token]", "unmatched"],
    ["/produk/[slug]", "unmatched"],
    [undefined, "gate"],
    ["/produk/abc?phone=6281234567890", "unmatched"],
  ] as const) {
    writeRequestLog(
      buildRequestLog({
        tenant_id: "t-a",
        host_kind: "tenant",
        route: routeLabel(pattern, fallback),
        method: "POST",
        status: 200,
        duration_ms: 3,
        request_id: "req-1",
      }),
      (text) => lines.push(text),
    );
  }
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(parsed.map((line) => line.route), ["/api/webhooks/[provider]/[token]", "/produk/[slug]", "gate", "unmatched"]);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["duration_ms", "event", "host_kind", "method", "request_id", "route", "status", "tenant_id"]);
  assert.doesNotMatch(lines.join("\n"), /6281234567890|secret-token/);
});

test("OBS-1: invocation logs are off in wrangler.jsonc, and PLATFORM_DB has its own chain", () => {
  const source = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as {
    observability: { logs?: { invocation_logs?: boolean } };
    d1_databases: Array<{ binding: string; migrations_dir: string }>;
    routes: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }>;
    vars: Record<string, string>;
  };
  assert.equal(config.observability.logs?.invocation_logs, false);
  assert.equal(config.d1_databases.find((db) => db.binding === "PLATFORM_DB")?.migrations_dir, "src/platform/migrations");
  // Every seller host on the SaaS zone; the platform hosts as Custom Domains on adsbook.id.
  assert.deepEqual(config.routes, [
    { pattern: "*/*", zone_name: "adsbook.my.id" },
    { pattern: "adsbook.id", custom_domain: true },
    { pattern: "app.adsbook.id", custom_domain: true },
  ]);
  // Public configuration only: a secret (CF_SAAS_TOKEN, TURNSTILE_SECRET_KEY,
  // PLATFORM_*_SECRET/KEY) is a `wrangler secret`, never a var in this file.
  assert.equal(config.vars.CF_SAAS_ZONE_ID, "2f704188a5333380dd6082f25d6bd74a");
  assert.deepEqual(Object.keys(config.vars).sort(), ["CF_SAAS_ZONE_ID", "TURNSTILE_SITE_KEY"]);
});

test("Paduka 2026-11-16: the seller zone's apex and www go to the platform's main domain; DCV paths still pass through", async () => {
  for (const [href, location] of [
    ["https://adsbook.my.id/", "https://adsbook.id/"],
    ["https://adsbook.my.id/harga?utm_source=fb", "https://adsbook.id/harga?utm_source=fb"],
    ["https://WWW.adsbook.my.id./daftar", "https://adsbook.id/daftar"],
  ]) {
    const result = await gateRequest(new Request(href), new URL(href), {}, {});
    assert.equal(result.kind, "refused", href);
    assert.equal(result.kind === "refused" && result.response.status, 301, href);
    assert.equal(result.kind === "refused" && result.response.headers.get("location"), location, href);
  }
  // No control-plane read happens for it (no PLATFORM_DB was given above), and a
  // certificate validation on the apex is still handed on untouched.
  let passed = false;
  const dcv = await gateRequest(new Request("https://adsbook.my.id/.well-known/acme-challenge/t"), new URL("https://adsbook.my.id/.well-known/acme-challenge/t"), {}, {
    passThrough: async () => ((passed = true), new Response("token")),
  });
  assert.equal(dcv.kind, "validation");
  assert.equal(passed, true);
  // A store subdomain is untouched by this rule (it reaches the control plane).
  const store = await gateRequest(new Request("https://toko.adsbook.my.id/"), new URL("https://toko.adsbook.my.id/"), {}, {});
  assert.notEqual(store.kind === "refused" && store.response.status, 301);
});

test("ADR-039 (c): 0007 moves a store's own subdomain from adsbook.cc to adsbook.my.id, and nothing else", async () => {
  const db = await controlPlane();
  db.sqlite.exec(`INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-a', 'agro', 'a@example.test', 'active', '2026-11-16');
    INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES
      ('agro.adsbook.cc', 't-a', 'subdomain', 'active', 1, '2026-11-16'),
      ('agro.example.cc', 't-a', 'custom', 'pending', 0, '2026-11-16');`);
  // The rows a store created on the old zone, as the live PLATFORM_DB held them; then 0007 runs.
  db.sqlite.exec(CHAIN.find((entry) => entry.name.startsWith("0007_"))!.sql);
  const hosts = db.sqlite.prepare("SELECT host, kind, is_primary FROM tenant_hosts ORDER BY host").all().map((row) => ({ ...(row as object) }));
  assert.deepEqual(hosts, [
    { host: "agro.adsbook.my.id", kind: "subdomain", is_primary: 1 },
    { host: "agro.example.cc", kind: "custom", is_primary: 0 },
  ]);
  assert.equal(tenantOf((await gate(db, "https://agro.adsbook.my.id/")).result), "t-a");
  assert.equal(statusOf((await gate(db, "https://agro.adsbook.cc/")).result), 404, "the old name no longer routes");
});

test("Paket 1: bumpTenantCacheVersion moves an active tenant's version, never another's, and never throws", async () => {
  const db = await controlPlane();
  addTenant(db, "t_a", "toko-a");
  addTenant(db, "t_b", "toko-b");
  addTenant(db, "t_s", "toko-s", "suspended");
  const version = (id: string) => (db.sqlite.prepare("SELECT cache_version FROM tenants WHERE id = ?").get(id) as { cache_version: number }).cache_version;
  const before = { a: version("t_a"), b: version("t_b"), s: version("t_s") };
  assert.equal(await bumpTenantCacheVersion({ PLATFORM_DB: db }, "t_a"), true);
  assert.equal(await bumpTenantCacheVersion({ PLATFORM_DB: db }, "t_a"), true);
  assert.equal(version("t_a"), before.a + 2);
  assert.equal(version("t_b"), before.b, "another tenant's cache is untouched");
  assert.equal(await bumpTenantCacheVersion({ PLATFORM_DB: db }, "t_s"), false, "a suspended tenant's version is the operator's");
  assert.equal(version("t_s"), before.s);
  assert.equal(await bumpTenantCacheVersion({}, "t_a"), false, "no control plane: nothing to bump");
  assert.equal(await bumpTenantCacheVersion({ PLATFORM_DB: db }, undefined), false);
  const broken = { prepare() { throw new Error("D1 down"); } };
  assert.equal(await bumpTenantCacheVersion({ PLATFORM_DB: broken }, "t_a"), false, "a failure never fails the save");
});


test("AUTH migration 0010 on a live control plane: owners backfilled, live tokens kept, a duplicate owner email stops the file whole", async () => {
  const { ensureSchemaUpgraded } = await import("../lib/schema-version.ts");
  const before = CHAIN.slice(0, 10);
  const db = createSqliteD1();
  await ensureSchemaUpgraded(db, { migrations: before, expected: before.length, cache: false });
  db.sqlite.exec(`
    INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES
      ('t_a', 'toko-a', 'Pemilik@A.example ', 'active', '2026-11-01'),
      ('t_b', 'toko-b', 'b@b.example', 'suspended', '2026-11-02'),
      ('t_c', 'toko-c', 'c@c.example', 'purged', '2026-11-03'),
      ('t_d', 'toko-d', 'c@c.example', 'active', '2026-11-04');
    INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at) VALUES ('h1', 't_a', 'signup', 'toko-a.adsbook.my.id', '2099-01-01');
  `);
  await ensureControlPlane(db, CHAIN);
  assert.deepEqual(
    db.sqlite.prepare("SELECT identifier, tenant_id, kind FROM platform_identities ORDER BY identifier").all().map((row) => ({ ...(row as object) })),
    [
      { identifier: "b@b.example", tenant_id: "t_b", kind: "owner_email" },
      { identifier: "c@c.example", tenant_id: "t_d", kind: "owner_email" },
      { identifier: "pemilik@a.example", tenant_id: "t_a", kind: "owner_email" },
    ],
    "every store that is not purged, lowercased and trimmed",
  );
  assert.deepEqual({ ...db.sqlite.prepare("SELECT token_hash, purpose, username FROM handoff_tokens").get() }, { token_hash: "h1", purpose: "signup", username: null });
  db.sqlite.prepare("INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at, username) VALUES ('h2', 't_a', 'login', 'h', '2099-01-01', 'x')").run();
  assert.throws(() => db.sqlite.prepare("INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at) VALUES ('h3', 't_a', 'lain', 'h', '2099-01-01')").run(), /CHECK/);
  assert.ok(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'handoff_tokens_expires'").get(), "the expiry index is back");

  // Two live stores on one email: the unique index fails, and nothing of 0010 is applied.
  const dup = createSqliteD1();
  await ensureSchemaUpgraded(dup, { migrations: before, expected: before.length, cache: false });
  dup.sqlite.exec(`INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t_x', 'x', 'sama@x.example', 'active', '2026-11-01'), ('t_y', 'y', 'SAMA@x.example', 'active', '2026-11-01');`);
  await assert.rejects(ensureControlPlane(dup, CHAIN), /SCHEMA_UPGRADE_APPLY_FAILED/);
  assert.equal(dup.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'platform_identities'").get(), undefined, "rolled back whole");
});
