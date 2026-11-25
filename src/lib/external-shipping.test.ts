import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { withTestCredentials } from "../platform/testing/credentials.ts";
import { readDashboardAnalytics } from "./dashboard-analytics.ts";
import {
  applyOrderLifecycleMutation,
  OrderLifecycleError,
  resolveAdminOrderTransition,
} from "./order-lifecycle.ts";
import { shippingListFilter } from "./order-list-filter.ts";
import { matchesShippingQueue } from "./shipping-queue.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[a-z]+$/i.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);
const migrationText = (name: string) =>
  readFileSync(new URL(name, MIGRATIONS_DIR), "utf8").replaceAll("--> statement-breakpoint", "");

function allMigrations() {
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
}

function migratedSqlite(stopBeforeSuffix?: string) {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of allMigrations()) {
    if (stopBeforeSuffix && name.endsWith(stopBeforeSuffix)) break;
    sqlite.exec(migrationText(name));
  }
  return sqlite;
}

type SqlValue = null | number | string;

class Statement {
  readonly sqlite: DatabaseSync;
  readonly sql: string;
  readonly values: SqlValue[];
  constructor(sqlite: DatabaseSync, sql: string, values: SqlValue[] = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: SqlValue[]) {
    return new Statement(this.sqlite, this.sql, values);
  }
  async first<T>() {
    return (this.sqlite.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async all<T>() {
    return { success: true, results: this.sqlite.prepare(this.sql).all(...this.values) as T[], meta: {} };
  }
  async run() {
    return this.execute();
  }
  execute() {
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return { success: true, results: this.sqlite.prepare(this.sql).all(...this.values), meta: { changes: 0 } };
    }
    const info = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  }
}

function d1(sqlite: DatabaseSync) {
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  withTestCredentials(db);
  return db as unknown as D1Database;
}

function seedStoreAndOrders(sqlite: DatabaseSync, mengantarApiKey: string | null) {
  sqlite.prepare(
    `INSERT INTO stores (id, name, slug, created_at, mengantar_api_key, mengantar_base_url)
     VALUES (1, 'Toko Uji', 'toko-uji', '2026-11-01T00:00:00.000Z', ?, 'https://provider.invalid')`,
  ).run(mengantarApiKey);
  sqlite.exec(`
    INSERT INTO products (id, store_id, title, slug, is_active, created_at)
    VALUES (1, 1, 'Produk Fisik', 'produk-fisik', 1, '2026-11-01T00:00:00.000Z');
    INSERT INTO product_variants (id, product_id, title, sku, price, stock, weight_grams)
    VALUES (10, 1, 'Standard', 'SKU-1', 100000, 10, 500);
  `);
}

test("X-1 migration: stores with Mengantar key keep 'mengantar'; stores without key default unpushed orders to 'external'", () => {
  const suffix = "_order_shipping_channel.sql";
  const channelMigration = allMigrations().find((name) => name.endsWith(suffix));
  assert.ok(channelMigration, "shipping_channel migration exists");

  // Store WITH Mengantar API key
  const withKey = migratedSqlite(suffix);
  seedStoreAndOrders(withKey, "mengantar-live-key");
  withKey.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, provider_order_id, created_at)
    VALUES
      (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'pending', NULL, '2026-11-20T03:00:00.000Z'),
      (2, 'INV-10002', 1, 'Siti', '6281234567891', 'Jl. Merdeka No. 11', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'processing', 'MG-2', '2026-11-20T04:00:00.000Z');
  `);
  withKey.exec(migrationText(channelMigration));
  const withKeyRows = (withKey.prepare("SELECT id, shipping_channel FROM orders ORDER BY id").all() as Array<{ id: number; shipping_channel: string }>).map((row) => ({ ...row }));
  assert.deepEqual(withKeyRows, [
    { id: 1, shipping_channel: "mengantar" },
    { id: 2, shipping_channel: "mengantar" },
  ]);

  // Store WITHOUT Mengantar API key
  const withoutKey = migratedSqlite(suffix);
  seedStoreAndOrders(withoutKey, null);
  withoutKey.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, provider_order_id, created_at)
    VALUES
      (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'pending', NULL, '2026-11-20T03:00:00.000Z'),
      (2, 'INV-10002', 1, 'Siti', '6281234567891', 'Jl. Merdeka No. 11', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'processing', 'MG-2', '2026-11-20T04:00:00.000Z');
  `);
  withoutKey.exec(migrationText(channelMigration));
  const withoutKeyRows = (withoutKey.prepare("SELECT id, shipping_channel FROM orders ORDER BY id").all() as Array<{ id: number; shipping_channel: string }>).map((row) => ({ ...row }));
  assert.deepEqual(withoutKeyRows, [
    { id: 1, shipping_channel: "external" },
    { id: 2, shipping_channel: "mengantar" },
  ]);
});

test("X-2/X-8 lifecycle: external order advances with courier + resi without provider_order_id and voids RTS once", async () => {
  const base = {
    id: 1,
    payment_method: "cod",
    payment_status: "unpaid",
    shipping_status: "pending",
    courier_code: null as string | null,
    cnote_no: null as string | null,
    provider_order_id: null as string | null,
    stock_restored_at: null as string | null,
    shipping_channel: "external",
  };

  // External pending -> processing is allowed without provider_order_id
  assert.equal(resolveAdminOrderTransition(base, { shippingStatus: "processing" }).shippingStatus, "processing");

  // External pending -> shipped without courier/resi is refused
  assert.throws(
    () => resolveAdminOrderTransition(base, { shippingStatus: "shipped" }),
    (error: unknown) => error instanceof OrderLifecycleError && error.status === 400,
  );

  // External with courier + resi can advance through shipped -> delivered
  const withWaybill = { ...base, courier_code: "JNE", cnote_no: "EXT-RESI-001" };
  assert.equal(resolveAdminOrderTransition(withWaybill, { shippingStatus: "shipped" }).shippingStatus, "shipped");
  assert.equal(
    resolveAdminOrderTransition({ ...withWaybill, shipping_status: "shipped" }, { shippingStatus: "delivered" }).shippingStatus,
    "delivered",
  );

  // Non-COD external still cannot be marked delivered while unpaid
  assert.throws(
    () =>
      resolveAdminOrderTransition(
        { ...withWaybill, payment_method: "manual_transfer", payment_status: "pending", shipping_status: "shipped" },
        { shippingStatus: "delivered" },
      ),
    (error: unknown) => error instanceof OrderLifecycleError && /non-COD/i.test(error.message),
  );

  // Mengantar order still requires provider_order_id
  assert.throws(
    () => resolveAdminOrderTransition({ ...withWaybill, shipping_channel: "mengantar" }, { shippingStatus: "shipped" }),
    (error: unknown) => error instanceof OrderLifecycleError && /Mengantar/.test(error.message),
  );

  // RTS on external order voids stock_restored_at exactly once via applyOrderLifecycleMutation
  const sqlite = migratedSqlite();
  seedStoreAndOrders(sqlite, "mengantar-key");
  sqlite.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, courier_code, cnote_no, shipping_channel, created_at)
    VALUES (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'shipped', 'JNE', 'EXT-RESI-001', 'external', '2026-11-20T03:00:00.000Z');
  `);
  const db = d1(sqlite);
  const firstRts = await applyOrderLifecycleMutation(
    db,
    { ...withWaybill, shipping_status: "shipped" },
    { shippingStatus: "returned" },
    db.prepare("UPDATE orders SET shipping_status = 'returned' WHERE id = 1 AND shipping_status = 'shipped'"),
  );
  assert.equal(firstRts.updated, true);
  assert.equal(firstRts.stockRestored, true);
  const stamped = sqlite.prepare("SELECT shipping_status, stock_restored_at FROM orders WHERE id = 1").get() as { shipping_status: string; stock_restored_at: string | null };
  assert.equal(stamped.shipping_status, "returned");
  assert.ok(stamped.stock_restored_at, "stock_restored_at stamped once");

  // Second RTS does not restore again, and reactivation is refused
  const secondRts = await applyOrderLifecycleMutation(
    db,
    { ...withWaybill, shipping_status: "returned", stock_restored_at: stamped.stock_restored_at },
    { shippingStatus: "returned" },
    db.prepare("UPDATE orders SET shipping_status = 'returned' WHERE id = 1 AND shipping_status = 'returned'"),
  );
  assert.equal(secondRts.stockRestored, false);
  await assert.rejects(
    () =>
      applyOrderLifecycleMutation(
        db,
        { ...withWaybill, shipping_status: "returned", stock_restored_at: stamped.stock_restored_at },
        { shippingStatus: "delivered" },
        db.prepare("UPDATE orders SET shipping_status = 'delivered' WHERE id = 1"),
      ),
    OrderLifecycleError,
  );
});

test("X-3/X-8 API orders/[id]: manual cnote_no allowed only for external orders without provider_order_id", async () => {
  const { PATCH } = await import("../pages/api/admin/orders/[id].ts");
  const sqlite = migratedSqlite();
  seedStoreAndOrders(sqlite, "mengantar-key");
  sqlite.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, shipping_channel, created_at)
    VALUES
      (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'pending', 'mengantar', '2026-11-20T03:00:00.000Z'),
      (2, 'INV-10002', 1, 'Siti', '6281234567891', 'Jl. Merdeka No. 11', 'Jawa Barat', 'Bandung', 'Coblong', 110000, 'cod', 'unpaid', 'processing', 'mengantar', '2026-11-20T04:00:00.000Z');
    UPDATE orders SET provider_order_id = 'MG-200', courier_code = 'JNE', cnote_no = 'MG-RESI-2' WHERE id = 2;
  `);
  const db = d1(sqlite);
  const patchOrder = (id: number, body: Record<string, unknown>) =>
    PATCH({
      params: { id: String(id) },
      request: new Request(`https://toko.test/api/admin/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      locals: { tenantDb: db, runtimeEnv: {}, admin: { username: "owner", role: "owner" } },
    } as unknown as Parameters<typeof PATCH>[0]);

  // 1. Mengantar order refuses manual cnote_no
  const mengantarResi = await patchOrder(1, { cnote_no: "MANUAL-1" });
  assert.equal(mengantarResi.status, 409);

  // 2. Switching order #1 to external + manual courier + manual resi + shipped succeeds atomically
  const externalSave = await patchOrder(1, {
    shipping_channel: "external",
    courier_code: "SiCepat",
    courier_service: "REG",
    cnote_no: "SICEPAT-999",
    shipping_status: "shipped",
  });
  assert.equal(externalSave.status, 200);
  const savedBody = (await externalSave.json()) as { data: { shipping_channel: string; courier_code: string; cnote_no: string; shipping_status: string } };
  assert.equal(savedBody.data.shipping_channel, "external");
  assert.equal(savedBody.data.courier_code, "SiCepat");
  assert.equal(savedBody.data.cnote_no, "SICEPAT-999");
  assert.equal(savedBody.data.shipping_status, "shipped");

  // 3. External order cannot be dispatched to Mengantar
  const dispatchExternal = await patchOrder(1, { action: "dispatch-order" });
  assert.equal(dispatchExternal.status, 409);

  // 4. Order with provider_order_id cannot switch to external or overwrite cnote_no
  const switchDispatched = await patchOrder(2, { shipping_channel: "external", cnote_no: "HIJACK" });
  assert.equal(switchDispatched.status, 409);
});

test("X-5/X-6/X-7: shipping list & dashboard funnel include external orders, while Mengantar sync & pickup skip them", async () => {
  const { GET: shippingGet, PATCH: shippingPatch } = await import("../pages/api/admin/shipping.ts");
  const sqlite = migratedSqlite();
  seedStoreAndOrders(sqlite, "mengantar-key");
  sqlite.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, courier_code, cnote_no, provider_order_id, shipping_channel, created_at)
    VALUES
      (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 100000, 'cod', 'unpaid', 'processing', 'JNE', 'MG-RESI-1', 'MG-1', 'mengantar', '2026-11-20T03:00:00.000Z'),
      (2, 'INV-10002', 1, 'Siti', '6281234567891', 'Jl. Merdeka No. 11', 'Jawa Barat', 'Bandung', 'Coblong', 150000, 'cod', 'unpaid', 'shipped', 'SiCepat', 'EXT-RESI-2', NULL, 'external', '2026-11-20T04:00:00.000Z'),
      (3, 'INV-10003', 1, 'Ani', '6281234567892', 'Jl. Merdeka No. 12', 'Jawa Barat', 'Bandung', 'Coblong', 80000, 'cod', 'unpaid', 'processing', 'J&T', 'EXT-RESI-3', NULL, 'external', '2026-11-20T05:00:00.000Z');
  `);
  const db = d1(sqlite);

  // shippingListFilter includes both Mengantar and external
  const filter = shippingListFilter(new URLSearchParams());
  assert.equal(filter.ok, true);
  assert.match(filter.conditions.join(" "), /shipping_channel = 'external'/);

  // Shipping queue excludes external orders from Mengantar pickup/waybill/drop-off queues
  assert.equal(
    matchesShippingQueue(
      { shippingStatus: "processing", cnoteNo: "EXT-RESI-3", providerOrderId: null, pickupScheduleId: null, shippingChannel: "external" },
      "needs_pickup",
    ),
    false,
  );
  assert.equal(
    matchesShippingQueue(
      { shippingStatus: "delivered", cnoteNo: "EXT-RESI-3", providerOrderId: null, pickupScheduleId: null, shippingChannel: "external" },
      "delivered",
    ),
    true,
  );

  // GET /api/admin/shipping returns all 3 orders with channel labels, readyPickupIds contains only Mengantar #1
  const getResp = await shippingGet({
    url: new URL("https://toko.test/api/admin/shipping"),
    locals: { tenantDb: db, runtimeEnv: {} },
  } as unknown as Parameters<typeof shippingGet>[0]);
  assert.equal(getResp.status, 200);
  const getBody = (await getResp.json()) as { data: { shipments: Array<{ id: number; shippingChannel: string }>; readyPickupIds: number[] } };
  assert.deepEqual(
    getBody.data.shipments.map((s) => [s.id, s.shippingChannel]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [[1, "mengantar"], [2, "external"], [3, "external"]],
  );
  assert.deepEqual(getBody.data.readyPickupIds, [1]);

  // sync-provider skips external orders completely (never calls fetch for order #2 or #3)
  const calledUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calledUrls.push(String(input));
    return new Response(
      JSON.stringify({ status: "success", data: [{ cnote_no: "MG-RESI-1", isDelivered: false, isPickedUp: true }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const syncAll = await shippingPatch({
      request: new Request("https://toko.test/api/admin/shipping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-provider" }),
      }),
      locals: { tenantDb: db, runtimeEnv: {} },
    } as unknown as Parameters<typeof shippingPatch>[0]);
    assert.equal(syncAll.status, 200);
    assert.equal(calledUrls.length, 1, "only Mengantar order #1 queried");
    assert.match(calledUrls[0], /MG-RESI-1/);

    const syncExplicitExternal = await shippingPatch({
      request: new Request("https://toko.test/api/admin/shipping", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-provider", orderIds: [2] }),
      }),
      locals: { tenantDb: db, runtimeEnv: {} },
    } as unknown as Parameters<typeof shippingPatch>[0]);
    assert.equal(syncExplicitExternal.status, 200);
    assert.equal(calledUrls.length, 1, "explicit sync for external order never calls Mengantar");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Dashboard funnel handed_over counts both Mengantar (#1) and external shipped (#2), not external processing (#3)
  const analytics = await readDashboardAnalytics(db, {
    startDate: "2026-11-20",
    endDate: "2026-11-20",
    interval: "day",
  });
  assert.equal(analytics.funnel.orders, 3);
  assert.equal(analytics.funnel.handed_over, 2);
});
