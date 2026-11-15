// SPIKE-1 node half: the engine and adapter under node:sqlite. The workerd half
// is scripts/measure.mjs against `wrangler dev --local`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { splitMigrationStatements } from "../../src/lib/schema-version.ts";
import { persistOrder, recordAbandonedOrder } from "../../src/lib/order-persistence.ts";
import { deleteOrdersReleasingReservations, updateAdminOrderShippingStatuses } from "../../src/lib/order-lifecycle.ts";
import { createNodeStorage } from "./src/node-sql.ts";
import {
  applyMigrationFile,
  executeBatch,
  executeStatement,
  readLedger,
  TENANT_STORE_PROTOCOL,
  type MigrationFile,
  type StorageLike,
} from "./src/store-core.ts";
import { createTenantDb, type TenantStoreRpc } from "./src/tenant-db.ts";

const dir = new URL("../../src/db/migrations/", import.meta.url);
const CHAIN: MigrationFile[] = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

/** An in-process stand-in for the RPC hop: arguments and results are structured-cloned. */
function rpcOver(storage: StorageLike): TenantStoreRpc {
  return {
    async query(protocol, statement, raw) {
      assert.equal(protocol, TENANT_STORE_PROTOCOL);
      return structuredClone(executeStatement(storage, structuredClone(statement), raw));
    },
    async batch(protocol, statements) {
      assert.equal(protocol, TENANT_STORE_PROTOCOL);
      return structuredClone(executeBatch(storage, structuredClone(statements)));
    },
  };
}

function migrated() {
  const storage = createNodeStorage();
  for (const file of CHAIN) applyMigrationFile(storage, file, splitMigrationStatements);
  return storage;
}

const schema = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name`,
    )
    .all()
    .map((row) => ({ ...row, sql: String((row as { sql: string | null }).sql ?? "").replace(/\s+/g, " ") }));

test("the full chain replays through the engine to the same schema the D1 test doubles build", () => {
  const storage = migrated();
  assert.equal(readLedger(storage).length, CHAIN.length);
  const reference = new DatabaseSync(":memory:");
  for (const file of CHAIN) for (const statement of splitMigrationStatements(file.sql)) reference.exec(statement);
  assert.deepEqual(schema(storage.db), schema(reference));
});

test("a failing file rolls back with its ledger row; the files before it stay", () => {
  const storage = createNodeStorage();
  for (const file of CHAIN.slice(0, 5)) applyMigrationFile(storage, file, splitMigrationStatements);
  assert.throws(() =>
    applyMigrationFile(storage, { name: "0005_bad.sql", sql: "CREATE TABLE half (id INTEGER);\nINSERT INTO nowhere VALUES (1);" }, splitMigrationStatements),
  );
  assert.equal(readLedger(storage).length, 5);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half'").get()?.n, 0);
});

test("meta.changes counts trigger writes, as D1 reports them", async () => {
  const storage = migrated();
  const db = createTenantDb(rpcOver(storage));
  storage.db.exec(`
    INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'T', 't', '2026-11-01');
    INSERT INTO orders (order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, created_at)
    VALUES ('INV-1', 1, 'A', '62812', 'x', 'p', 'c', 'd', 1, '2026-11-01'), ('INV-2', 1, 'A', '62812', 'x', 'p', 'c', 'd', 1, '2026-11-01');
  `);
  const result = await db.prepare("UPDATE orders SET shipping_status = 'processing'").run();
  // Two rows, each bumped again by the 0075 updated_at trigger.
  assert.equal(result.meta.changes, 4);
  assert.equal(result.meta.changed_db, true);
});

test("a batch is all or nothing through the adapter", async () => {
  const storage = migrated();
  const db = createTenantDb(rpcOver(storage));
  await db.prepare("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'T', 't', '2026-11-01')").run();
  await assert.rejects(
    db.batch([
      db.prepare("UPDATE stores SET name = 'changed' WHERE id = 1"),
      db.prepare("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'dup', 'dup', '2026-11-01')"),
    ]),
    /UNIQUE constraint failed/,
  );
  assert.equal(await db.prepare("SELECT name FROM stores WHERE id = 1").first("name"), "T");
});

test("D1 binding rules: booleans become 1/0, undefined is refused, first(column) and raw() match D1", async () => {
  const db = createTenantDb(rpcOver(createNodeStorage()));
  assert.deepEqual(await db.prepare("SELECT ? AS t, ? AS f").bind(true, false).first(), { t: 1, f: 0 });
  assert.throws(() => db.prepare("SELECT ?").bind(undefined), /D1_TYPE_ERROR/);
  assert.equal(await db.prepare("SELECT 7 AS n").first("n"), 7);
  await assert.rejects(db.prepare("SELECT 7 AS n").first("missing"), /D1_COLUMN_NOTFOUND/);
  assert.deepEqual(await db.prepare("SELECT 1 AS a, 'x' AS b").raw({ columnNames: true }), [["a", "b"], [1, "x"]]);
  assert.deepEqual(await db.prepare("SELECT ?1 AS a, ?1 || ?2 AS b").bind("x", "y").first(), { a: "x", b: "xy" });
  await assert.rejects(db.exec("SELECT 1"), /TENANT_DB_UNSUPPORTED/);
});

test("a statement from another tenant's store cannot join a batch", async () => {
  const a = createTenantDb(rpcOver(createNodeStorage()));
  const b = createTenantDb(rpcOver(createNodeStorage()));
  await assert.rejects(a.batch([b.prepare("SELECT 1")]), /TENANT_DB_FOREIGN_STATEMENT/);
});

test("real checkout, lead and lifecycle code runs unchanged through the adapter", async () => {
  const storage = migrated();
  const db = createTenantDb(rpcOver(storage));
  storage.db.exec(`
    INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko', 'toko', '2026-11-01');
    INSERT INTO products (id, store_id, title, slug, created_at) VALUES (11111, 1, 'Pupuk', 'pupuk', '2026-11-01');
    INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (101, 11111, 'P-1', '1 kg', 50000), (102, 11111, 'P-2', '2 kg', 90000);
  `);
  const lead = await recordAbandonedOrder(db, { customerName: "Siti Rahayu", customerPhone: "081234567890", variantId: 102 });
  const order = await persistOrder(db, {
    submitToken: "sb_spike_node_conformance",
    customerName: "Siti Rahayu",
    customerPhone: "6281234567890",
    address: "Jl. Melati 10, Bogor",
    province: "Jawa Barat",
    city: "Bogor",
    district: "Bogor Tengah",
    variantKey: "101",
    quantity: 2,
    shippingCost: 10000,
    paymentMethod: "cod",
  });
  assert.equal(order.created, true);
  assert.equal(order.id, lead.id, "checkout promotes the lead");
  assert.deepEqual(
    await updateAdminOrderShippingStatuses(db, [order.id], "cancelled"),
    { updatedIds: [order.id], conflictIds: [] },
  );
  assert.deepEqual(
    (await deleteOrdersReleasingReservations(db, [order.id])).map((row) => row.id),
    [order.id],
  );
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM orders").first("n"), 0);
});
