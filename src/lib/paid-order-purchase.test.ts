import { bindTestCredentialsIn } from "../platform/testing/credentials.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { enqueuePurchaseForPaidOrder, manualTransferBecamePaid } from "./paid-order-purchase.ts";

type Row = Record<string, unknown>;

function createDatabase__raw(options: {
  paymentStatus: string;
  shippingStatus?: string;
  stockRestoredAt?: string | null;
  pixel: boolean;
  alreadyQueued?: boolean;
  /** What the checkout stored on the order, if anything. */
  metaRequestContext?: string;
  fulfillmentType?: string;
  customerEmail?: string;
}) {
  const outbox: Row[] = [];
  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT meta_pixel_id")) {
            return options.pixel
              ? { meta_pixel_id: "123", meta_capi_token: "tok", google_tag_manager_id: null, google_ads_conversion_id: null, google_ads_conversion_label: null }
              : { meta_pixel_id: null, meta_capi_token: null };
          }
          if (sql.includes("FROM orders o")) {
            return {
              order_number: "INV-10041",
              customer_name: "Siti Rahayu",
              customer_phone: "081234567890",
              customer_email: options.customerEmail ?? null,
              ...(sql.includes("o.fulfillment_type") ? { fulfillment_type: options.fulfillmentType ?? "physical" } : {}),
              province: "Jawa Barat",
              city: "Bogor",
              postal_code: "16111",
              payment_status: options.paymentStatus,
              // Only what the query names: dropping a column from the SELECT
              // must reach the guard as a missing value, the way D1 would.
              ...(sql.includes("o.shipping_status") ? { shipping_status: options.shippingStatus ?? "pending" } : {}),
              ...(sql.includes("o.stock_restored_at") ? { stock_restored_at: options.stockRestoredAt ?? null } : {}),
              ad_click_ids: null,
              meta_request_context: options.metaRequestContext ?? null,
              product_value: 150_000,
            };
          }
          if (sql.includes("capi_event_outbox")) return null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async all() {
          if (sql.includes("FROM order_items oi")) {
            return { results: [{ product_id: 100001, title: "Pupuk Organik" }] };
          }
          if (sql.includes("FROM capi_event_outbox")) return { results: [] };
          throw new Error(`unexpected all(): ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO capi_event_outbox")) {
            if (options.alreadyQueued) return { meta: { changes: 0 } };
            outbox.push({ event_id: values[0], event_name: values[1], payload: JSON.parse(String(values[2])) });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { database, outbox };
}

const locals = (database: D1Database) =>
  ({ tenantDb: database, runtimeEnv: { OMS_DB: database}, tenant: { siteUrl: "https://store.example.test" } }) as unknown as App.Locals;

test("a paid order enqueues one Purchase keyed on its order number", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({ events_received: 1 });
  const { database, outbox } = createDatabase({ paymentStatus: "paid", pixel: true });

  const result = await enqueuePurchaseForPaidOrder(database, locals(database), 41);
  assert.equal(result.status, "queued");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].event_id, "INV-10041");
  assert.equal(outbox[0].event_name, "Purchase");
  const payload = outbox[0].payload as { eventSourceUrl: string; customData: Row; userData: Row };
  assert.equal(payload.eventSourceUrl, "https://store.example.test/thanks");
  // Goods only, the same figure the browser leg sends.
  assert.equal(payload.customData.value, 150_000);
  assert.deepEqual(payload.customData.contentIds, ["100001"]);
  assert.equal(payload.userData.externalId, "6281234567890");
  // This order carries no stored context, so there is nothing to send and
  // nothing is invented to fill the gap.
  assert.equal("fbp" in payload.userData, false);
});

test("an unpaid order, an unconfigured pixel, and an already-sent Purchase are all no-ops", async () => {
  const unpaid = createDatabase({ paymentStatus: "pending", pixel: true });
  assert.deepEqual(await enqueuePurchaseForPaidOrder(unpaid.database, locals(unpaid.database), 41), {
    status: "skipped",
    reason: "order-not-paid",
  });
  const noPixel = createDatabase({ paymentStatus: "paid", pixel: false });
  assert.equal((await enqueuePurchaseForPaidOrder(noPixel.database, locals(noPixel.database), 41)).status, "skipped");
  const sent = createDatabase({ paymentStatus: "paid", pixel: true, alreadyQueued: true });
  assert.deepEqual(await enqueuePurchaseForPaidOrder(sent.database, locals(sent.database), 41), {
    status: "deduplicated",
  });
  assert.equal(sent.outbox.length, 0);
});

/**
 * "Transfer Diterima" on an order already cancelled or returned records the
 * money, but a void order is a refund to make, not a conversion to report.
 * The guard sits in the shared enqueue, so the cron and reconciliation paths
 * hold it too.
 */
test("a paid but void order never enqueues a Purchase", async () => {
  for (const void_ of [
    { shippingStatus: "cancelled" },
    { shippingStatus: "returned" },
    { shippingStatus: "pending", stockRestoredAt: "2026-10-28 10:00:00" },
  ]) {
    const { database, outbox } = createDatabase({ paymentStatus: "paid", pixel: true, ...void_ });
    assert.deepEqual(await enqueuePurchaseForPaidOrder(database, locals(database), 41), {
      status: "skipped",
      reason: "order-void",
    });
    assert.equal(outbox.length, 0);
  }
});

/**
 * A COD Purchase is confirmed hours or days later, from a cron or an admin
 * click, with no request of the buyer's own. Everything Meta matches on beyond
 * the phone number has to come off the order or the event goes out weak — so
 * this fails if the wiring between checkout capture and the server-side event
 * is ever broken.
 */
test("a stored checkout context reaches the server-side Purchase", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({ events_received: 1 });

  const { database, outbox } = createDatabase({
    paymentStatus: "paid",
    pixel: true,
    metaRequestContext: JSON.stringify({
      fbp: "fb.1.1700000000000.1234567890",
      fbc: "fb.1.1700000000000.AbCdEf",
      externalId: "0123456789abcdef0123456789abcdef",
      clientIp: "203.0.113.9",
      userAgent: "Mozilla/5.0 (Linux; Android 13)",
    }),
  });

  const result = await enqueuePurchaseForPaidOrder(database, locals(database), 41);
  assert.equal(result.status, "queued");
  const payload = outbox[0].payload as { userData: Row };

  assert.equal(payload.userData.fbp, "fb.1.1700000000000.1234567890");
  assert.equal(payload.userData.fbc, "fb.1.1700000000000.AbCdEf");
  assert.equal(payload.userData.clientIp, "203.0.113.9");
  assert.equal(payload.userData.userAgent, "Mozilla/5.0 (Linux; Android 13)");
  // The stored external id is the browser's own; the phone is only the fallback.
  assert.equal(payload.userData.externalId, "0123456789abcdef0123456789abcdef");
  // Meta reads a missing country as a missing key rather than a default.
  assert.equal(payload.userData.country, "id");
});

test("only a manual transfer turning paid is an operator-confirmed Purchase", () => {
  assert.equal(manualTransferBecamePaid("manual_transfer", "pending", "paid"), true);
  assert.equal(manualTransferBecamePaid("manual_transfer", "unpaid", "settled"), true);
  // Already paid: re-saving the order must not report it again.
  assert.equal(manualTransferBecamePaid("manual_transfer", "paid", "paid"), false);
  assert.equal(manualTransferBecamePaid("manual_transfer", "pending", "failed"), false);
  // COD's Purchase is the persisted order, sent from /thanks.
  assert.equal(manualTransferBecamePaid("cod", "unpaid", "paid"), false);
  // QRIS and VA are confirmed by AutoLaris reconciliation, which sends its own.
  assert.equal(manualTransferBecamePaid("bank_transfer", "pending", "paid"), false);
});

// ── COD sweep (audit 2026-11-10, F-1) against the real migration chain ──────

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { splitMigrationStatements } from "./schema-version.ts";
import { sweepMissedCodPurchases } from "./paid-order-purchase.ts";

function sweepDatabase__raw() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of splitMigrationStatements(readFileSync(new URL(name, directory), "utf8"))) {
      sqlite.exec(statement);
    }
  }
  sqlite.exec(`
    INSERT INTO stores (id, name, slug, created_at, meta_pixel_id, meta_capi_token)
    VALUES (1, 'Toko Uji', 'toko-uji', '2026-11-01T00:00:00.000Z', '1234567890', 'tok');
    INSERT INTO products (id, store_id, title, slug, created_at) VALUES (11111, 1, 'Pupuk', 'pupuk', '2026-11-01T00:00:00.000Z');
    INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (101, 11111, 'P-1', '1 kg', 50000);
  `);
  const statement = (sql: string, values: unknown[] = []) => ({
    sql,
    bind: (...next: unknown[]) => statement(sql, next.map((value) => value ?? null)),
    first: async () => sqlite.prepare(sql).get(...(values as never[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(values as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(values as never[])).changes) } }),
  });
  const database = { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
  const insert = sqlite.prepare(`INSERT INTO orders (order_number, store_id, customer_name, customer_phone, address,
    province, city, district, total_amount, created_at, payment_method, payment_status, shipping_status, stock_restored_at)
    VALUES (?, 1, 'Siti Rahayu', '081234567890', 'Jl. Melati 10', 'Jawa Barat', 'Bogor', 'Kec', 60000, ?, ?, ?, ?, ?)`);
  const item = sqlite.prepare("INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES (?, 101, 1, 50000)");
  const order = (number: string, at: string, method = "cod", payment = "unpaid", shipping = "pending", restored: string | null = null) => {
    const id = Number(insert.run(number, at, method, payment, shipping, restored).lastInsertRowid);
    item.run(id);
    return id;
  };
  const purchases = () =>
    (sqlite.prepare("SELECT event_id, payload FROM capi_event_outbox WHERE event_name = 'Purchase' ORDER BY event_id").all() as Array<{ event_id: string; payload: string }>);
  return { sqlite, database, order, purchases };
}

test("the hourly sweep sends the COD Purchase /thanks never did, once, and nothing else", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).data[0].event_id);
    return Response.json({ events_received: 1 });
  }) as typeof fetch;
  const now = new Date("2026-11-10T12:00:00.000Z");
  const { sqlite, database, order, purchases } = sweepDatabase();
  order("INV-10001", "2026-11-10T09:00:00.000Z"); // missed: 3 h old, no Purchase
  order("INV-10002", "2026-11-10T09:30:00.000Z"); // /thanks already sent it
  sqlite.exec(`INSERT INTO capi_event_outbox (event_id, event_name, payload, status, next_retry_at, created_at, updated_at)
    VALUES ('INV-10002', 'Purchase', '{}', 'sent', 't', 't', 't')`);
  order("INV-10003", "2026-11-10T11:45:00.000Z"); // 15 min: /thanks still has its chance
  order("INV-10004", "2026-11-07T12:00:00.000Z"); // 3 days: outside Meta's 48 h dedupe window
  order("ABN-10005", "2026-11-10T09:00:00.000Z", "cod", "unpaid", "abandoned"); // a lead
  order("INV-10006", "2026-11-10T09:00:00.000Z", "cod", "unpaid", "cancelled"); // void
  order("INV-10007", "2026-11-10T09:00:00.000Z", "cod", "unpaid", "pending", "2026-11-10T10:00:00.000Z"); // void
  order("INV-10008", "2026-11-10T09:00:00.000Z", "manual_transfer", "pending"); // not paid
  // A funnel event on the same id must not mask the missing Purchase (0057).
  sqlite.exec(`INSERT INTO capi_event_outbox (event_id, event_name, payload, status, next_retry_at, created_at, updated_at)
    VALUES ('INV-10001', 'PageView', '{}', 'sent', 't', 't', 't')`);

  const locals = { tenantDb: database, runtimeEnv: { OMS_DB: database}, tenant: { siteUrl: "https://store.example.test" } } as unknown as App.Locals;
  assert.equal(await sweepMissedCodPurchases(database, locals, now), 1);
  assert.deepEqual(purchases().map((row) => row.event_id), ["INV-10001", "INV-10002"]);
  assert.deepEqual(sent, ["INV-10001"]);
  // Stamped when the buyer purchased, not when the cron noticed.
  const payload = JSON.parse(purchases()[0].payload);
  assert.equal(payload.eventTime, Math.floor(Date.parse("2026-11-10T09:00:00.000Z") / 1000));
  assert.equal(payload.customData.value, 50_000);

  // The next hour: INV-10003 has now waited past /thanks's chance and goes;
  // INV-10001 is never sent twice.
  assert.equal(await sweepMissedCodPurchases(database, locals, new Date("2026-11-10T13:00:00.000Z")), 1);
  assert.deepEqual(sent, ["INV-10001", "INV-10003"]);
  assert.equal(await sweepMissedCodPurchases(database, locals, new Date("2026-11-10T14:00:00.000Z")), 0);
  assert.deepEqual(sent, ["INV-10001", "INV-10003"]);
});

test("the sweep does nothing for a store without Meta configured", async () => {
  const { sqlite, database, order, purchases } = sweepDatabase();
  sqlite.exec("UPDATE stores SET meta_pixel_id = NULL, meta_capi_token = NULL");
  order("INV-10001", "2026-11-10T09:00:00.000Z");
  const locals = { tenantDb: database, runtimeEnv: { OMS_DB: database}, tenant: { siteUrl: "https://store.example.test" } } as unknown as App.Locals;
  assert.equal(await sweepMissedCodPurchases(database, locals, new Date("2026-11-10T12:00:00.000Z")), 0);
  assert.equal(purchases().length, 0);
});

test("checkout sends the COD Purchase itself; a later /thanks or sweep is a no-op", async (context) => {
  const { scheduleCodPurchase } = await import("./paid-order-purchase.ts");
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).data[0].event_id);
    return Response.json({ events_received: 1 });
  }) as typeof fetch;
  const { database, order, purchases } = sweepDatabase();
  const cod = order("INV-10001", "2026-11-10T09:00:00.000Z");
  const transfer = order("INV-10002", "2026-11-10T09:00:00.000Z", "manual_transfer", "pending");
  const waits: Promise<unknown>[] = [];
  const locals = {
    tenantDb: database, runtimeEnv: { OMS_DB: database},
    tenant: { siteUrl: "https://store.example.test" },
    cfContext: { waitUntil: (task: Promise<unknown>) => waits.push(task) },
  } as unknown as App.Locals;
  scheduleCodPurchase(database, locals, cod, "cod");
  scheduleCodPurchase(database, locals, transfer, "manual_transfer");
  await Promise.all(waits);
  assert.deepEqual(sent, ["INV-10001"], "an unpaid transfer is not a Purchase");
  assert.equal(JSON.parse(purchases()[0].payload).customData.value, 50_000);
  // The hourly sweep finds nothing left to send.
  assert.equal(await sweepMissedCodPurchases(database, locals, new Date("2026-11-10T12:00:00.000Z")), 0);
  assert.deepEqual(sent, ["INV-10001"]);
});

test("every checkout route hands its order to scheduleCodPurchase", () => {
  for (const route of ["../pages/api/submit-order.ts", "../pages/api/submit-middle-order.ts", "../pages/api/v1/checkout.ts"]) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8");
    assert.match(source, /scheduleCodPurchase\(database, locals, order\.id,/, route);
  }
});

test("the coverage signal fires on a COD order Meta never heard of, and only then", async () => {
  const { readPurchaseCoverage, classifyPurchaseCoverage } = await import("./operational-health.ts");
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const { sqlite, database, order } = sweepDatabase();
  order("INV-10001", "2026-11-10T06:00:00.000Z"); // 6 h, Purchase sent
  sqlite.exec(`INSERT INTO capi_event_outbox (event_id, event_name, payload, status, next_retry_at, created_at, updated_at)
    VALUES ('INV-10001', 'Purchase', '{}', 'sent', 't', 't', 't')`);
  order("INV-10002", "2026-11-10T11:30:00.000Z"); // 30 min: still inside its send window
  order("ABN-10003", "2026-11-10T06:00:00.000Z", "cod", "unpaid", "abandoned");
  order("INV-10004", "2026-11-10T06:00:00.000Z", "manual_transfer", "pending");
  let coverage = await readPurchaseCoverage(database, now);
  assert.deepEqual(coverage, { orders: 1, missing: 0 });
  assert.equal(classifyPurchaseCoverage(coverage, true, now).state, "healthy");

  order("INV-10005", "2026-11-10T05:00:00.000Z"); // 7 h, never enqueued
  coverage = await readPurchaseCoverage(database, now);
  assert.deepEqual(coverage, { orders: 2, missing: 1 });
  const signal = classifyPurchaseCoverage(coverage, true, now);
  assert.deepEqual([signal.state, signal.reason], ["degraded", "orders-without-purchase"]);
  // A store that never configured Meta has nothing to be owed.
  assert.equal(classifyPurchaseCoverage(coverage, false, now).state, "unknown");
  assert.equal(classifyPurchaseCoverage(null, true, now).reason, "unreadable");
});

test("a lead is never deleted, however old; an ordinary order still is (owner 2026-11-10)", async () => {
  const { deleteOrdersReleasingReservations, OrderLifecycleError } = await import("./order-lifecycle.ts");
  const { sqlite, database, order } = sweepDatabase();
  const oldLead = order("ABN-10001", "2026-08-01T00:00:00.000Z", "cod", "unpaid", "abandoned");
  const lead = order("ABN-10002", "2026-11-09T00:00:00.000Z", "cod", "unpaid", "abandoned");
  const unpaid = order("INV-10003", "2026-11-09T00:00:00.000Z");
  const batchDatabase = Object.assign(database, {
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          const sql = (statement as unknown as { sql?: string }).sql;
          results.push(sql && /RETURNING/i.test(sql) ? await (statement as unknown as { all: () => Promise<unknown> }).all() : await statement.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  }) as unknown as D1Database;
  await assert.rejects(
    deleteOrdersReleasingReservations(batchDatabase, [oldLead]),
    (error: unknown) => error instanceof OrderLifecycleError && /lead dan tidak pernah dihapus/.test(error.message),
  );
  // Mixed with a real order, the whole request is refused, not half-run.
  await assert.rejects(deleteOrdersReleasingReservations(batchDatabase, [unpaid, lead]), OrderLifecycleError);
  const count = () => Number((sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n);
  assert.equal(count(), 3);
  assert.equal(Number((sqlite.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?").get(oldLead) as { n: number }).n), 1);
});

test("a CS-converted lead becomes one Purchase carrying the buyer's own captured identity", async (context) => {
  const { recordAbandonedOrder } = await import("./order-persistence.ts");
  const { convertAbandonedLead } = await import("./abandoned-lead.ts");
  const { scheduleCodPurchase } = await import("./paid-order-purchase.ts");
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sent: Array<{ event_id: string; user_data: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).data[0]);
    return Response.json({ events_received: 1 });
  }) as typeof fetch;
  const { sqlite, database } = sweepDatabase();
  sqlite.exec(`INSERT INTO warehouses (id, store_id, name, origin_area_id, pickup_address_id, address, city, province) VALUES (4, 1, 'Gudang', 'a', 'p', 'Jl', 'Bandung', 'Jawa Barat')`);
  const batchDatabase = Object.assign(database, {
    batch: async (statements: Array<{ run: () => Promise<unknown>; all: () => Promise<unknown> }>) => {
      const results = [];
      for (const statement of statements) {
        const sql = (statement as unknown as { sql?: string }).sql ?? "";
        results.push(/RETURNING|^\s*SELECT/i.test(sql) ? await statement.all() : await statement.run());
      }
      return results;
    },
  }) as unknown as D1Database;
  const lead = await recordAbandonedOrder(batchDatabase, {
    customerName: "Siti Rahayu",
    customerPhone: "081234567890",
    variantId: 101,
    metaRequestContext: JSON.stringify({ fbp: "fb.1.1700000000000.42", fbc: "fb.1.1700000000000.click", clientIp: "203.0.113.9", userAgent: "FBAN/Android" }),
    adClickIds: JSON.stringify({ fbclid: "click" }),
  });
  const stored = sqlite.prepare("SELECT meta_request_context, ad_click_ids FROM orders WHERE id = ?").get(lead.id) as Record<string, string>;
  assert.match(stored.meta_request_context, /fb\.1\.1700000000000\.click/);
  assert.match(stored.ad_click_ids, /fbclid/);

  const converted = await convertAbandonedLead(batchDatabase, lead.id, {
    customerName: "Siti Rahayu", customerPhone: "081234567890", address: "Jalan Melati Nomor 10",
    district: "Coblong", city: "Bandung", province: "Jawa Barat", postalCode: "40132",
    destinationAreaId: "area-1", variantId: 101, quantity: 1, warehouseId: 4,
    courierCode: "jne", courierService: "REG", shippingCost: 18_000, followedUpBy: "cs",
  });
  const waits: Promise<unknown>[] = [];
  const locals = {
    tenantDb: batchDatabase, runtimeEnv: { OMS_DB: batchDatabase},
    tenant: { siteUrl: "https://store.example.test" },
    cfContext: { waitUntil: (task: Promise<unknown>) => waits.push(task) },
  } as unknown as App.Locals;
  scheduleCodPurchase(batchDatabase, locals, converted.id, "cod");
  await Promise.all(waits);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event_id, converted.orderNumber);
  assert.match(converted.orderNumber, /^INV-/);
  // The buyer's capture, not the operator's browser.
  assert.equal(sent[0].user_data.fbc, "fb.1.1700000000000.click");
  assert.equal(sent[0].user_data.client_ip_address, "203.0.113.9");
});

test("the CS conversion route reports the converted order to Meta", () => {
  const source = readFileSync(new URL("../pages/api/admin/abandoned-orders.ts", import.meta.url), "utf8");
  assert.match(source, /scheduleCodPurchase\(database, locals, converted\.id, "cod"\)/);
});

// ── PR-6: the scheduled run resolves the store's identity from D1 ───────────
// `src/worker.ts` run for real; only Astro's handler and Vite's migration glob
// are stubbed (the same two stubs as health-snapshot.test.ts).

import { registerHooks } from "node:module";
import { defaultTenantConfig } from "./tenant.ts";

const HANDLER_STUB = "stub:astro-cloudflare-handler";
const MIGRATIONS_STUB = "stub:bundled-migrations";
// Not deregistered: `schema-version.ts` imports the migration chain lazily, on
// the first scheduled run. node --test gives this file its own process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@astrojs/cloudflare/handler") return { url: HANDLER_STUB, shortCircuit: true };
    // worker.ts re-exports TenantStore (T-18); only its base class is needed here, and no `env`.
    if (specifier === "cloudflare:workers") return { url: "stub:cloudflare-workers", shortCircuit: true };
    if (/bundled-migrations(\.ts)?$/.test(specifier)) return { url: MIGRATIONS_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || /\.[a-z0-9]+$/i.test(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
  load(url, context, nextLoad) {
    if (url === "stub:cloudflare-workers") {
      return { format: "module", source: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
    }
    if (url === HANDLER_STUB) {
      return { format: "module", source: "export const handle = () => new Response('');", shortCircuit: true };
    }
    if (url === MIGRATIONS_STUB) {
      const directory = new URL("../db/migrations/", import.meta.url);
      const migrations = readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => ({ name, sql: readFileSync(new URL(name, directory), "utf8") }));
      return { format: "module", source: `export const BUNDLED_MIGRATIONS = ${JSON.stringify(migrations)};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const workerModule = (await import("../platform/tenant-maintenance.ts")) as unknown as {
  runTenantMaintenance(env: Record<string, unknown>, database: D1Database, tenantId: string, scheduledTime: number, ctx: unknown): Promise<void>;
};
const { ensureSchemaUpgraded: applyTenantChain } = await import("./schema-version.ts");
// One tenant's maintenance (T-34). `openTenantDb` brings a store to the
// release before maintenance runs; here the test applies the chain itself.
const worker = {
  async scheduled(controller: { scheduledTime: number }, env: Record<string, unknown>, ctx: unknown) {
    const database = env.OMS_DB as D1Database;
    await applyTenantChain(database);
    await workerModule.runTenantMaintenance(env, database, "t-test", controller.scheduledTime, ctx);
  },
};

const D1_SITE = "https://toko-asli.example.test";
const CRON_TIME = Date.parse("2026-11-10T12:00:00.000Z");

/** An empty database the scheduled run migrates itself, then a wizard-configured store with one missed COD order. */
async function cronStore() {
  const sqlite = new DatabaseSync(":memory:");
  let failWhen: RegExp | null = null;
  const statement = (sql: string, values: unknown[] = []) => {
    const execute = () => {
      if (failWhen?.test(sql)) throw new Error("D1_ERROR: injected");
      if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { success: true, results: sqlite.prepare(sql).all(...(values as never[])), meta: { changes: 0 } };
      const info = sqlite.prepare(sql).run(...(values as never[]));
      return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    };
    return {
      execute,
      bind: (...next: unknown[]) => statement(sql, next.map((value) => value ?? null)),
      run: async () => execute(),
      all: async () => execute(),
      first: async () => {
        if (failWhen?.test(sql)) throw new Error("D1_ERROR: injected");
        return sqlite.prepare(sql).get(...(values as never[])) ?? null;
      },
    };
  };
  const database = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<ReturnType<typeof statement>>) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((item) => item.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  bindTestCredentialsIn(database);

  const sent: Array<{ event_id: string; event_source_url: string; user_data: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const run = async () => {
    const original = { fetch: globalThis.fetch, info: console.info, error: console.error, warn: console.warn };
    console.info = () => {};
    console.warn = () => {};
    console.error = (label: unknown) => {
      errors.push(String(label));
    };
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const event = JSON.parse(String(init?.body ?? "{}")).data?.[0];
      if (event) sent.push(event);
      return Response.json({ events_received: 1 });
    }) as typeof fetch;
    try {
      await worker.scheduled({ scheduledTime: CRON_TIME }, { OMS_DB: database }, { waitUntil() {}, passThroughOnException() {} });
    } finally {
      globalThis.fetch = original.fetch;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
  };

  await applyTenantChain(database); // the chain on the empty database, as openTenantDb would
  sqlite.exec(`
    INSERT INTO stores (id, name, slug, created_at, site_url, meta_pixel_id, meta_capi_token)
    VALUES (1, 'Toko Asli', 'toko-asli', '2026-11-01T00:00:00.000Z', '${D1_SITE}', '1234567890', 'tok');
    INSERT INTO products (id, store_id, title, slug, created_at) VALUES (11111, 1, 'Pupuk', 'pupuk', '2026-11-01T00:00:00.000Z');
    INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (101, 11111, 'P-1', '1 kg', 50000);
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, customer_email, address,
      province, city, district, total_amount, created_at, payment_method, payment_status, shipping_status)
    VALUES (1, 'INV-10001', 1, 'Siti Rahayu', '6281234567890', '6281234567890@toko-asli.example.test', 'Jl. Melati 10',
      'Jawa Barat', 'Bogor', 'Kec', 60000, '2026-11-10T09:00:00.000Z', 'cod', 'unpaid', 'pending');
    INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES (1, 101, 1, 50000);
  `);
  sent.length = 0;
  errors.length = 0;
  const queued = () =>
    JSON.parse(
      (sqlite.prepare("SELECT payload FROM capi_event_outbox WHERE event_id = 'INV-10001' AND event_name = 'Purchase'").get() as { payload: string }).payload,
    ) as { eventSourceUrl: string; userData: { email?: string } };
  return { run, sent, errors, queued, failIdentityRead: () => (failWhen = /SELECT name, slug, site_url/) };
}

test("a scheduled Purchase carries the store's own URL from D1, and its minted email is not sent", async () => {
  assert.notEqual(new URL(defaultTenantConfig.siteUrl).host, new URL(D1_SITE).host, "the env fallback must differ for this to prove anything");
  const { run, sent, queued } = await cronStore();
  await run();

  assert.equal(queued().eventSourceUrl, `${D1_SITE}/thanks`);
  assert.equal(queued().userData.email, undefined, "a <phone>@<store host> address is minted, not a match key");
  const purchase = sent.find((event) => event.event_id === "INV-10001");
  assert.ok(purchase, "the sweep delivers the Purchase inline");
  assert.equal(purchase.event_source_url, `${D1_SITE}/thanks`);
  assert.equal("em" in purchase.user_data, false, "the minted email must not be hashed into user_data");
  assert.ok(purchase.user_data.ph, "the phone is still a match key");
});

test("TEN-5: a tenant whose identity cannot be read skips its run and sends nothing", async () => {
  const { run, sent, failIdentityRead } = await cronStore();
  failIdentityRead();
  // Never a default identity: the run stops before any step, and the alarm
  // logs the failure with the tenant id (tenant-alarm.ts).
  await assert.rejects(run(), /TENANT_IDENTITY_UNAVAILABLE/);
  assert.equal(sent.length, 0);
});

// T-48: the fixture handle carries the test credential key, like a real tenant handle.
function createDatabase(...args: Parameters<typeof createDatabase__raw>): ReturnType<typeof createDatabase__raw> {
  return bindTestCredentialsIn(createDatabase__raw(...args));
}

// T-48: the fixture handle carries the test credential key, like a real tenant handle.
function sweepDatabase(...args: Parameters<typeof sweepDatabase__raw>): ReturnType<typeof sweepDatabase__raw> {
  return bindTestCredentialsIn(sweepDatabase__raw(...args));
}

test("review finding 3: a paid digital order's server Purchase carries the buyer, never a place", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({ events_received: 1 });
  // The row still holds address values (an older placeholder, a stray value): the type decides.
  const { database, outbox } = createDatabase({ paymentStatus: "paid", pixel: true, fulfillmentType: "digital", customerEmail: "budi@example.test" });
  assert.equal((await enqueuePurchaseForPaidOrder(database, locals(database), 41)).status, "queued");
  const userData = (outbox[0].payload as { userData: Row }).userData;
  assert.equal(userData.phone, "081234567890");
  assert.equal(userData.name, "Siti Rahayu");
  assert.equal(userData.email, "budi@example.test");
  assert.equal(userData.country, "id");
  assert.ok(userData.externalId);
  assert.equal(userData.city, undefined, "ct");
  assert.equal(userData.province, undefined, "st");
  assert.equal(userData.postalCode, undefined, "zp");
  // A physical order keeps its place.
  const physical = createDatabase({ paymentStatus: "paid", pixel: true });
  await enqueuePurchaseForPaidOrder(physical.database, locals(physical.database), 41);
  const physicalUser = (physical.outbox[0].payload as { userData: Row }).userData;
  assert.deepEqual([physicalUser.city, physicalUser.province, physicalUser.postalCode], ["Bogor", "Jawa Barat", "16111"]);
});

test("review finding 3: the browser's Purchase leg drops a digital order's place too", () => {
  const source = readFileSync(new URL("../pages/api/meta-event.ts", import.meta.url), "utf8");
  for (const field of ["city", "province", "postalCode"]) {
    assert.match(source, new RegExp(`${field}: purchaseOrder\\?\\.fulfillment_type === 'digital' \\? undefined`), field);
  }
});

