import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { withTestCredentials } from "../platform/testing/credentials.ts";
import {
  MENGANTAR_RECONCILE_BATCH_LIMIT,
  reconcileStaleMengantarOrders,
} from "./mengantar-shipping-sync.ts";

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);
const migrationText = (name: string) =>
  readFileSync(new URL(name, MIGRATIONS_DIR), "utf8").replaceAll("--> statement-breakpoint", "");

function migratedSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort()) {
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

function seedStore(sqlite: DatabaseSync, options: { apiKey?: string | null; catalogMode?: "physical" | "digital" | "hybrid" } = {}) {
  const apiKey = options.apiKey === undefined ? "mengantar-test-key" : options.apiKey;
  const catalogMode = options.catalogMode ?? "physical";
  sqlite.prepare(
    `INSERT INTO stores (id, name, slug, created_at, mengantar_api_key, mengantar_base_url, catalog_mode)
     VALUES (1, 'Toko Reconcile', 'toko-reconcile', '2026-11-01T00:00:00.000Z', ?, 'https://provider.invalid', ?)`,
  ).run(apiKey, catalogMode);
}

function insertOrder(
  sqlite: DatabaseSync,
  input: {
    id: number;
    status?: string;
    channel?: "mengantar" | "external";
    providerOrderId?: string | null;
    cnoteNo?: string | null;
    syncedAt?: string | null;
  },
) {
  sqlite.prepare(
    `INSERT INTO orders (
       id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
       total_amount, payment_method, payment_status, shipping_status, courier_code, cnote_no,
       provider_order_id, shipping_channel, provider_synced_at, created_at
     ) VALUES (
       ?, ?, 1, 'Pembeli', '6281234567890', 'Jl. Merdeka 1', 'Jawa Barat', 'Bandung', 'Coblong',
       100000, 'cod', 'unpaid', ?, 'JNE', ?, ?, ?, ?, '2026-11-20T00:00:00.000Z'
     )`,
  ).run(
    input.id,
    `INV-${10000 + input.id}`,
    input.status ?? "processing",
    input.cnoteNo === undefined ? `RESI-${input.id}` : input.cnoteNo,
    input.providerOrderId === undefined ? `MG-${input.id}` : input.providerOrderId,
    input.channel ?? "mengantar",
    input.syncedAt === undefined ? null : input.syncedAt,
  );
}

const NOW = new Date("2026-11-25T12:00:00.000Z");

test("T-7 / R-2: reconciles only stale (>6h or unsynced) Mengantar orders, caps at 25, isolates per-order errors, and voids RTS once", async () => {
  const sqlite = migratedSqlite();
  seedStore(sqlite);

  // 1. Freshly synced 2h ago -> MUST be skipped
  insertOrder(sqlite, { id: 1, status: "processing", syncedAt: "2026-11-25T10:00:00.000Z" });
  // 2. External channel with cnote -> MUST be skipped
  insertOrder(sqlite, { id: 2, status: "shipped", channel: "external", providerOrderId: null, cnoteNo: "EXT-2", syncedAt: null });
  // 3. Terminal delivered -> MUST be skipped
  insertOrder(sqlite, { id: 3, status: "delivered", syncedAt: null });
  // 4. Stale 8h ago (processing -> delivered)
  insertOrder(sqlite, { id: 4, status: "processing", syncedAt: "2026-11-25T04:00:00.000Z" });
  // 5. Never synced (shipped -> RTS returned, voids stock_restored_at once)
  insertOrder(sqlite, { id: 5, status: "shipped", syncedAt: null });
  // 6. Never synced (provider throws error -> isolated, does not stop remaining orders)
  insertOrder(sqlite, { id: 6, status: "processing", syncedAt: null });
  // 7..35 (29 more stale orders -> total stale Mengantar = 32, must cap at 25)
  for (let id = 7; id <= 35; id += 1) {
    insertOrder(sqlite, { id, status: "processing", syncedAt: "2026-11-24T00:00:00.000Z" });
  }

  const queried: string[] = [];
  const fakeClient = {
    async getOrderByTrackingId(cnoteNo: string) {
      queried.push(cnoteNo);
      if (cnoteNo === "RESI-6") throw new Error("provider timeout");
      if (cnoteNo === "RESI-5") return { cnote_no: cnoteNo, status: JSON.stringify({ RTS: true }) };
      if (cnoteNo === "RESI-4") return { cnote_no: cnoteNo, status: JSON.stringify({ DELIVERED: true }) };
      return { cnote_no: cnoteNo, status: JSON.stringify({ PICKED_UP: true }) };
    },
  };

  const db = d1(sqlite);
  const summary = await reconcileStaleMengantarOrders(
    db,
    { tenant: { catalogMode: "physical" } } as App.Locals,
    NOW,
    { client: fakeClient },
  );

  assert.equal(summary.checked, MENGANTAR_RECONCILE_BATCH_LIMIT, "capped at 25 per tenant per hour");
  assert.equal(summary.failed, 1, "RESI-6 failure recorded");
  assert.equal(summary.synced, 24, "other 24 orders still synced despite RESI-6 throwing");
  assert.ok(!queried.includes("RESI-1"), "freshly synced order skipped");
  assert.ok(!queried.includes("EXT-2"), "external order never queried");
  assert.ok(!queried.includes("RESI-3"), "terminal order skipped");
  assert.ok(queried.includes("RESI-5"), "never-synced order prioritized");

  const order5 = sqlite.prepare("SELECT shipping_status, stock_restored_at, provider_synced_at FROM orders WHERE id = 5").get() as {
    shipping_status: string;
    stock_restored_at: string | null;
    provider_synced_at: string | null;
  };
  assert.equal(order5.shipping_status, "returned");
  assert.ok(order5.stock_restored_at, "RTS sets void marker once via applyOrderLifecycleMutation");
  assert.equal(order5.provider_synced_at, NOW.toISOString());
});

test("T-7 / R-3: skips Preview/expired stores, digital-only stores, and stores without Mengantar API key", async () => {
  const sqlite = migratedSqlite();
  seedStore(sqlite, { apiKey: "mengantar-key" });
  insertOrder(sqlite, { id: 1, status: "processing", syncedAt: null });
  const db = d1(sqlite);

  let called = 0;
  const spyClient = {
    async getOrderByTrackingId() {
      called += 1;
      return { cnote_no: "RESI-1", status: JSON.stringify({ DELIVERED: true }) };
    },
  };

  // Preview / expired store (ADR-041)
  const paused = await reconcileStaleMengantarOrders(
    db,
    { tenant: { catalogMode: "physical" }, billing: { state: "expired", adSignalsPaused: true } } as App.Locals,
    NOW,
    { client: spyClient },
  );
  assert.equal(paused.skippedReason, "billing_paused");
  assert.equal(paused.checked, 0);

  // Digital-only store
  const digital = await reconcileStaleMengantarOrders(
    db,
    { tenant: { catalogMode: "digital" } } as App.Locals,
    NOW,
    { client: spyClient },
  );
  assert.equal(digital.skippedReason, "digital_store");
  assert.equal(digital.checked, 0);
  assert.equal(called, 0, "neither Preview nor digital store calls Mengantar");

  // Store without Mengantar API key
  const noKeySqlite = migratedSqlite();
  seedStore(noKeySqlite, { apiKey: null });
  insertOrder(noKeySqlite, { id: 1, status: "processing", syncedAt: null });
  const noKey = await reconcileStaleMengantarOrders(
    d1(noKeySqlite),
    { tenant: { catalogMode: "physical" }, runtimeEnv: {} } as App.Locals,
    NOW,
  );
  assert.equal(noKey.skippedReason, "no_api_key");
  assert.equal(noKey.checked, 0);
});
