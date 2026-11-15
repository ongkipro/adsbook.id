/**
 * SPIKE-1 (T-16): a throwaway Worker that measures a SQLite Durable Object per
 * tenant behind a D1-shaped adapter. Local only (`wrangler dev --local`); it
 * has no route and is never deployed. Deleted when T-18 lands the real code.
 */
import type { DurableObjectNamespace, DurableObjectState } from "@cloudflare/workers-types";

import { splitMigrationStatements, ensureSchemaUpgraded } from "../../../src/lib/schema-version.ts";
import { persistOrder, recordAbandonedOrder } from "../../../src/lib/order-persistence.ts";
import {
  deleteOrdersReleasingReservations,
  updateAdminOrderShippingStatuses,
} from "../../../src/lib/order-lifecycle.ts";
import { CHAIN, PROBE } from "./migrations.generated.ts";
import { TENANT_STORE_PROTOCOL, type StatementDescriptor, type StatementResult } from "./store-core.ts";
import { createTenantDb, type TenantStoreRpc } from "./tenant-db.ts";
import { TenantStore, type SchemaState } from "./tenant-store.ts";

/** The real chain plus two spike-only files: 0080 succeeds, 0081 fails. */
export class SpikeTenantStore extends TenantStore {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env, [...CHAIN, ...PROBE], splitMigrationStatements);
  }
}

type Env = {
  TENANT_STORE: DurableObjectNamespace;
  REF_DB: D1Database;
  PLATFORM_DB: D1Database;
  /** A fresh local D1 for the lib comparison, untouched by the parity writes. */
  REF_LIB: D1Database;
};

type StoreStub = TenantStoreRpc & {
  schemaState(protocol: number): Promise<SchemaState>;
  prepareMigration(protocol: number): Promise<{ bookmark: string; applied: number }>;
  applyMigrations(protocol: number, target: number, bookmarkId: string): Promise<SchemaState>;
  restore(protocol: number, bookmark: string): Promise<void>;
  setRecovery(protocol: number, recovery: boolean): Promise<void>;
};

function store(env: Env, tenantId: string): StoreStub {
  const stub = env.TENANT_STORE.getByName(tenantId, { locationHint: "apac-se" });
  // The stub's RPC methods return the structured-clone of the store's results.
  return stub as unknown as StoreStub;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}

async function timeEach(n: number, run: (i: number) => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const start = performance.now();
    await run(i);
    samples.push(performance.now() - start);
  }
  return percentiles(samples);
}

async function platformSchema(env: Env) {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS migration_bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      bookmark TEXT NOT NULL, at TEXT NOT NULL)`),
    env.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS tenant_hosts (
      host TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL)`),
  ]);
}

/** §4.4 steps 2–3, driven by the Worker. */
async function migrateTenant(env: Env, tenantId: string, target: number, fault: string | null) {
  await platformSchema(env);
  const stub = store(env, tenantId);
  const { bookmark, applied } = await stub.prepareMigration(TENANT_STORE_PROTOCOL);
  if (applied >= target) return { applied, migrated: 0, bookmarkId: null };
  if (fault === "bookmark-fails") {
    try {
      await env.PLATFORM_DB.prepare("INSERT INTO no_such_table (x) VALUES (1)").run();
    } catch {
      return { error: "TENANT_MIGRATION_BOOKMARK_FAILED", applied: (await stub.schemaState(TENANT_STORE_PROTOCOL)).applied };
    }
  }
  if (fault === "bookmark-delayed") await new Promise((resolve) => setTimeout(resolve, 1500));
  const written = await env.PLATFORM_DB
    .prepare("INSERT INTO migration_bookmarks (tenant_id, schema_version, bookmark, at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(tenantId, applied, bookmark, new Date().toISOString())
    .first<{ id: number }>();
  if (!written?.id) return { error: "TENANT_MIGRATION_BOOKMARK_FAILED" };
  const state = await stub.applyMigrations(TENANT_STORE_PROTOCOL, target, String(written.id));
  return { applied: state.applied, migrated: state.applied - applied, bookmarkId: written.id, bookmark };
}

const SCHEMA_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'
  ORDER BY type, name`;

async function schemaOf(db: D1Database) {
  return (await db.prepare(SCHEMA_SQL).all<Record<string, string | null>>()).results.map((row) => ({
    ...row,
    sql: row.sql?.replace(/\s+/g, " ").trim() ?? null,
  }));
}

const SEED = [
  "INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko Spike', 'toko-spike', '2026-11-01T00:00:00.000Z')",
  "INSERT INTO products (id, store_id, title, slug, created_at) VALUES (11111, 1, 'Pupuk', 'pupuk', '2026-11-01T00:00:00.000Z')",
  "INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (101, 11111, 'P-1', '1 kg', 50000)",
  "INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (102, 11111, 'P-2', '2 kg', 90000)",
];

/** One order with an item; the shape every page and lifecycle path reads. */
function seedOrder(db: D1Database, i: number, status = "pending") {
  return db.batch([
    db.prepare(`INSERT INTO orders (order_number, store_id, customer_name, customer_phone, address, province, city, district,
        total_amount, created_at, payment_method, payment_status, shipping_status)
      VALUES (?, 1, 'Siti Rahayu', '6281234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, ?, 'cod', 'unpaid', ?)`)
      .bind(`INV-${20000 + i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), status),
    db.prepare("INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES (last_insert_rowid(), 101, 1, 50000)"),
  ]);
}

/** Writes whose `meta` must match local D1 (§11 item 2). */
async function parity(db: D1Database) {
  const out: Record<string, unknown> = {};
  const meta = (r: D1Result<unknown>) => ({
    changes: r.meta.changes,
    last_row_id: r.meta.last_row_id,
    changed_db: r.meta.changed_db,
    rows_read: r.meta.rows_read,
    rows_written: r.meta.rows_written,
    results: r.results.length,
  });
  await db.prepare("CREATE TABLE IF NOT EXISTS parity_t (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT UNIQUE, v INTEGER)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS parity_t_v ON parity_t (v)").run();
  out.indexed_insert = meta(await db.prepare("INSERT INTO parity_t (k, v) VALUES (?, ?)").bind("a", 1).run());
  out.indexed_insert_2 = meta(await db.prepare("INSERT INTO parity_t (k, v) VALUES (?, ?)").bind("b", 2).run());
  out.on_conflict_do_nothing = meta(await db.prepare("INSERT INTO parity_t (k, v) VALUES (?, ?) ON CONFLICT (k) DO NOTHING").bind("a", 9).run());
  out.noop_update = meta(await db.prepare("UPDATE parity_t SET v = v WHERE k = ?").bind("zzz").run());
  out.same_value_update = meta(await db.prepare("UPDATE parity_t SET v = 1 WHERE k = ?").bind("a").run());
  out.returning = meta(await db.prepare("UPDATE parity_t SET v = v + 1 RETURNING id, v").run());
  out.select = meta(await db.prepare("SELECT * FROM parity_t").all());
  // The 0075 trigger: one UPDATE on two orders bumps updated_at on each.
  await seedOrder(db, 900);
  await seedOrder(db, 901);
  out.trigger_update_two_orders = meta(
    await db.prepare("UPDATE orders SET shipping_status = 'processing' WHERE order_number IN ('INV-20900', 'INV-20901')").run(),
  );
  const batch = await db.batch([
    db.prepare("INSERT INTO parity_t (k, v) VALUES ('c', 3)"),
    db.prepare("SELECT COUNT(*) AS n FROM parity_t"),
  ]);
  out.batch = batch.map(meta);
  const atomic = await db
    .batch([db.prepare("INSERT INTO parity_t (k, v) VALUES ('d', 4)"), db.prepare("INSERT INTO parity_t (k, v) VALUES ('a', 5)")])
    .then(() => "committed", (error: Error) => `rolled back: ${error.message.replace(/^D1_ERROR: /, "").slice(0, 80)}`);
  out.batch_atomic = { outcome: atomic, d_present: (await db.prepare("SELECT COUNT(*) AS n FROM parity_t WHERE k = 'd'").first<{ n: number }>())?.n };
  out.first_column = await db.prepare("SELECT k, v FROM parity_t WHERE k = 'a'").first("v");
  out.raw_with_columns = await db.prepare("SELECT k, v FROM parity_t ORDER BY k LIMIT 2").raw({ columnNames: true });
  out.numbered_params = await db.prepare("SELECT ?1 AS a, ?1 || ?2 AS b").bind("x", "y").first();
  out.unique_error = await db.prepare("INSERT INTO parity_t (k, v) VALUES ('a', 1)").run().then(() => "no error", (e: Error) => e.message);
  return out;
}

/** Real lib functions through the adapter and through D1; outputs must match (§11 item 5). */
async function libConformance(db: D1Database) {
  const order = await persistOrder(db, {
    submitToken: "sb_spike_conformance_001",
    customerName: "Siti Rahayu",
    customerPhone: "081234567890",
    address: "Jl. Melati 10, Bogor",
    province: "Jawa Barat",
    city: "Bogor",
    district: "Bogor Tengah",
    variantKey: "101",
    quantity: 2,
    shippingCost: 10000,
    paymentMethod: "cod",
  });
  const lead = await recordAbandonedOrder(db, { customerName: "Budi Santoso", customerPhone: "081298765432", variantId: 102 });
  const leadAgain = await recordAbandonedOrder(db, { customerName: "Budi S", customerPhone: "081298765432", variantId: 101 });
  await seedOrder(db, 500);
  await seedOrder(db, 501);
  const ids = (await db.prepare("SELECT id FROM orders WHERE order_number IN ('INV-20500','INV-20501') ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
  const bulk = await updateAdminOrderShippingStatuses(db, ids, "cancelled");
  const deleted = await deleteOrdersReleasingReservations(db, [ids[0]]);
  const leadDelete = await deleteOrdersReleasingReservations(db, [lead.id]).then(() => "deleted", (e: Error) => e.message.slice(0, 40));
  const items = (await db.prepare("SELECT order_id, variant_id, quantity, unit_price FROM order_items ORDER BY order_id, id").all()).results;
  const orders = (await db.prepare("SELECT order_number, shipping_status, payment_status, total_amount, stock_restored_at IS NOT NULL AS voided FROM orders ORDER BY id").all()).results;
  return {
    order: { created: order.created, orderNumber: order.orderNumber, totalAmount: order.totalAmount, unitPrice: order.unitPrice },
    lead: { action: lead.action, again: leadAgain.action, same: lead.id === leadAgain.id },
    bulk,
    deleted: deleted.length,
    leadDelete,
    items,
    orders,
  };
}

async function migrateRef(env: Env, target: number) {
  return ensureSchemaUpgraded(env.REF_DB, { migrations: CHAIN.slice(0, target), expected: target, cache: false });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, area, id, action] = url.pathname.split("/");
    const param = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);
    try {
      if (area === "t" && id) {
        const stub = store(env, id);
        const db = createTenantDb(stub);
        switch (action) {
          case "migrate":
            return json(await migrateTenant(env, id, param("target", CHAIN.length), url.searchParams.get("fault")));
          case "state":
            return json(await stub.schemaState(TENANT_STORE_PROTOCOL));
          case "schema":
            return json(await schemaOf(db));
          case "seed":
            await db.batch(SEED.map((sql) => db.prepare(sql)));
            for (let i = 0; i < param("orders", 0); i += 1) await seedOrder(db, i);
            return json({ ok: true });
          case "parity":
            return json(await parity(db));
          case "lib":
            return json(await libConformance(db));
          case "count":
            return json(await db.prepare(`SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM order_items) AS items,
              (SELECT COUNT(*) FROM orders WHERE updated_at IS NOT NULL) AS stamped, (SELECT name FROM stores WHERE id = 1) AS store`).first());
          case "hit":
            return json(await db.prepare("SELECT id, order_number, total_amount FROM orders WHERE id = ?").bind(1 + (Date.now() % 50)).first());
          case "bench": {
            const n = param("n", 200);
            return json({
              read: await timeEach(n, (i) => db.prepare("SELECT id, order_number, total_amount FROM orders WHERE id = ?").bind(1 + (i % 50)).first()),
              insert_batch: await timeEach(n, (i) => seedOrder(db, 10000 + i)),
            });
          }
          case "restore": {
            const bookmark = String(url.searchParams.get("bookmark") ?? "");
            await stub.restore(TENANT_STORE_PROTOCOL, bookmark).catch(() => undefined);
            return json(await stub.schemaState(TENANT_STORE_PROTOCOL));
          }
          case "recovery":
            await stub.setRecovery(TENANT_STORE_PROTOCOL, url.searchParams.get("on") === "1");
            return json(await stub.schemaState(TENANT_STORE_PROTOCOL));
          case "probe":
            return json(await probe(db));
        }
      }
      if (area === "ref") {
        const db = env.REF_DB;
        switch (id) {
          case "migrate":
            return json(await migrateRef(env, param("target", CHAIN.length)));
          case "schema":
            return json(await schemaOf(db));
          case "seed":
            await db.batch(SEED.map((sql) => db.prepare(sql)));
            for (let i = 0; i < param("orders", 0); i += 1) await seedOrder(db, i);
            return json({ ok: true });
          case "parity":
            return json(await parity(db));
          case "lib": {
            const fresh = env.REF_LIB;
            await ensureSchemaUpgraded(fresh, { migrations: CHAIN, expected: CHAIN.length, cache: false });
            await fresh.batch(SEED.map((sql) => fresh.prepare(sql)));
            return json(await libConformance(fresh));
          }
          case "bench": {
            const n = param("n", 200);
            return json({
              read: await timeEach(n, (i) => db.prepare("SELECT id, order_number, total_amount FROM orders WHERE id = ?").bind(1 + (i % 50)).first()),
              insert_batch: await timeEach(n, (i) => seedOrder(db, 10000 + i)),
            });
          }
        }
      }
      if (area === "noop") return json({ ok: true });
      if (area === "resolve") {
        await platformSchema(env);
        await env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO tenant_hosts (host, tenant_id, status) VALUES ('toko-a.belanja.cc', 'tenant-a', 'active')").run();
        const n = param("n", 200);
        return json(await timeEach(n, () => env.PLATFORM_DB.prepare("SELECT tenant_id, status FROM tenant_hosts WHERE host = ?").bind("toko-a.belanja.cc").first()));
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: (error as Error).message }, 500);
    }
  },
};

/** §4.1 item 12 on local workerd. */
async function probe(db: D1Database) {
  const attempt = async (sql: string) =>
    db.prepare(sql).all().then((r) => ({ ok: true, rows: r.results.slice(0, 2) }), (e: Error) => ({ ok: false, error: e.message.slice(0, 120) }));
  return {
    foreign_keys: await attempt("PRAGMA foreign_keys"),
    user_version: await attempt("PRAGMA user_version"),
    begin: await attempt("BEGIN TRANSACTION"),
    optimize: await attempt("PRAGMA optimize"),
    defer_fk: await attempt("PRAGMA defer_foreign_keys = ON"),
    current_timestamp: await attempt("SELECT CURRENT_TIMESTAMP AS now"),
    json: await attempt("SELECT json_extract('{\"a\":[1,2]}', '$.a[1]') AS v"),
    sequence: await attempt("SELECT name FROM sqlite_sequence LIMIT 1"),
  };
}

export type { StatementDescriptor, StatementResult };
