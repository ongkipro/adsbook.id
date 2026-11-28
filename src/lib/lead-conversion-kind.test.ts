// Pesanan tertinggal holds leads for physical and digital products alike;
// converting one follows the product (2026-11-28): a physical lead becomes a
// COD order with address and courier, a digital lead a prepaid digital order
// with neither, never COD. Run against the real migrated schema.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AbandonedLeadError,
  convertAbandonedLead,
  convertDigitalLead,
  LEAD_CATALOG_MODE_SQL,
  LEAD_DIGITAL_ADDRESS,
} from "./abandoned-lead.ts";
import { CATALOG_MODE_FILTER_SQL } from "./catalog.ts";
import { DIGITAL_ORDER_ADDRESS } from "./order-persistence.ts";
import { digitalAccessOpen } from "./digital-access.ts";
import { POST as convertRoute } from "../pages/api/admin/abandoned-orders.ts";

// The order route imports its libs without an extension (Astro resolves them);
// node --test needs one. Same hook as external-shipping.test.ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

type SqlValue = null | number | string;
const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);

function migrated() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return sqlite;
}

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
  async run() {
    return this.execute();
  }
  execute() {
    if (/^\s*SELECT\b/i.test(this.sql)) return { success: true, results: this.sqlite.prepare(this.sql).all(...this.values), meta: { changes: 0 } };
    const info = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  }
}

function d1(sqlite: DatabaseSync) {
  return {
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
  } as unknown as D1Database;
}

function seed(catalogMode: "physical" | "digital" | "hybrid" = "hybrid") {
  const sqlite = migrated();
  sqlite.exec(`
    INSERT INTO stores (id, name, slug, created_at, catalog_mode) VALUES (1, 'Toko', 'toko', '2026-10-01T00:00:00.000Z', '${catalogMode}');
    INSERT INTO seller_bank_accounts (id, store_id, bank_code, account_holder, account_number, is_active, created_at, updated_at) VALUES (5, 1, 'bca', 'Toko', '1234567890', 1, '2026-10-01', '2026-10-01');
    INSERT INTO products (id, store_id, title, slug, created_at, product_type, digital_access_url, is_active)
      VALUES (1, 1, 'Pupuk', 'pupuk', '2026-10-01', 'physical', NULL, 1),
             (2, 1, 'E-book', 'ebook', '2026-10-01', 'digital', 'https://drive.example.test/x', 1);
    INSERT INTO product_variants (id, product_id, sku, title, price, weight_grams) VALUES (11, 1, 'P1', '1 kg', 50000, 1000), (21, 2, 'E1', 'PDF', 49000, 0);
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
      total_amount, created_at, payment_method, payment_status, shipping_status, customer_email)
      VALUES (7, 'ABN-10007', 1, 'Budi', '6281234567890', '', '', '', '', 49000, '2026-11-28T00:00:00.000Z', 'cod', 'unpaid', 'abandoned', NULL);
    INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES (7, 21, 1, 49000);
  `);
  return { sqlite, database: d1(sqlite) };
}

const digitalInput = {
  customerName: "Budi Santoso",
  customerPhone: "081234567890",
  customerEmail: "6281234567890@toko.test",
  variantId: 21,
  quantity: 2,
  payment: { payment_method: "manual_transfer" as const, seller_bank_account_id: 5 },
  followedUpBy: "cs",
};

test("the lead module restates catalog.ts and order-persistence.ts exactly (it ships to the lead list island)", () => {
  assert.equal(LEAD_CATALOG_MODE_SQL, CATALOG_MODE_FILTER_SQL.replace("product_type)", "p.product_type)"));
  assert.deepEqual(LEAD_DIGITAL_ADDRESS, DIGITAL_ORDER_ADDRESS);
});

test("a digital lead becomes a prepaid digital order: no address, courier or shipping, never COD", async () => {
  const { sqlite, database } = seed();
  const converted = await convertDigitalLead(database, 7, digitalInput);
  assert.equal(converted.orderNumber, "INV-10007");
  assert.equal(converted.totalAmount, 98000);
  const order = sqlite.prepare("SELECT * FROM orders WHERE id = 7").get() as Record<string, unknown>;
  assert.equal(order.fulfillment_type, "digital");
  assert.equal(order.payment_method, "manual_transfer");
  assert.equal(order.payment_status, "pending");
  assert.equal(order.shipping_status, "pending");
  assert.deepEqual([order.address, order.province, order.city, order.district], ["-", "-", "-", "-"]);
  assert.deepEqual([order.courier_code, order.courier_service, order.destination_area_id, order.warehouse_id], [null, null, null, null]);
  assert.deepEqual([order.shipping_cost, order.cod_service_fee, order.total_amount], [0, 0, 98000]);
  assert.equal(order.seller_account_number, "1234567890", "the transfer account the buyer is told to pay");
  assert.equal(order.customer_email, "6281234567890@toko.test");
  assert.equal(order.lead_follow_up_status, "converted");
  assert.ok(order.public_status_token, "the buyer gets an order page to pay from");
  assert.equal(digitalAccessOpen(order as never), false, "no access before payment");
  const items = sqlite.prepare("SELECT variant_id, quantity, unit_price FROM order_items WHERE order_id = 7").all();
  assert.deepEqual(items.map((row) => ({ ...row })), [{ variant_id: 21, quantity: 2, unit_price: 49000 }]);
  // A second operator finds nothing left to convert.
  await assert.rejects(convertDigitalLead(database, 7, digitalInput), (error: unknown) => error instanceof AbandonedLeadError && error.status === 404);
});

test("each path refuses the other kind: no COD digital order, no parcel without an address", async () => {
  const { sqlite, database } = seed();
  await assert.rejects(
    convertAbandonedLead(database, 7, {
      customerName: "Budi", customerPhone: "081234567890", address: "Jalan Merdeka Nomor 10", district: "Coblong", city: "Bandung",
      province: "Jawa Barat", destinationAreaId: "area-1", variantId: 21, quantity: 1, warehouseId: 1, courierCode: "jne",
      courierService: "REG", shippingCost: 18000, followedUpBy: "cs",
    }),
    (error: unknown) => error instanceof AbandonedLeadError && error.status === 422,
  );
  await assert.rejects(convertDigitalLead(database, 7, { ...digitalInput, variantId: 11 }), (error: unknown) => error instanceof AbandonedLeadError && error.status === 422);
  const order = sqlite.prepare("SELECT shipping_status FROM orders WHERE id = 7").get() as { shipping_status: string };
  assert.equal(order.shipping_status, "abandoned", "nothing was written");
});

test("a product outside the store's catalog mode cannot be converted", async () => {
  const { database } = seed("physical");
  await assert.rejects(convertDigitalLead(database, 7, digitalInput), (error: unknown) => error instanceof AbandonedLeadError && error.status === 404);
});

test("the route converts a digital lead with a payment and no courier, and refuses one without a payment method", async () => {
  const { sqlite, database } = seed();
  const call = (body: Record<string, unknown>) =>
    convertRoute({
      request: new Request("https://toko.test/api/admin/abandoned-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      locals: { tenantDb: database, runtimeEnv: { OMS_DB: database }, admin: { username: "cs" }, tenant: { siteUrl: "https://toko.test" } },
    } as never);
  const base = { action: "convert", order_id: 7, variant_id: 21, quantity: 1, customer_name: "Budi Santoso", customer_phone: "081234567890" };
  const missing = await call({ ...base, payment: { payment_method: "cod" } });
  assert.equal(missing.status, 422);
  const response = await call({ ...base, payment: { payment_method: "manual_transfer", seller_bank_account_id: 5 } });
  const payload = (await response.json()) as { success: boolean; data: { order_number: string; fulfillment_type: string } };
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual([payload.data.order_number, payload.data.fulfillment_type], ["INV-10007", "digital"]);
  const order = sqlite.prepare("SELECT fulfillment_type, payment_method, customer_email FROM orders WHERE id = 7").get() as Record<string, string>;
  assert.deepEqual({ ...order }, { fulfillment_type: "digital", payment_method: "manual_transfer", customer_email: "6281234567890@toko.test" });
  // A physical request (courier, no payment) for a digital product is refused by the physical path.
  const { database: other } = seed();
  const physical = await convertRoute({
    request: new Request("https://toko.test/api/admin/abandoned-orders", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, courier_service_id: 1, destination_area_id: "area", city: "Bandung", courier_code: "jne", province: "Jawa Barat" }),
    }),
    locals: { tenantDb: other, runtimeEnv: { OMS_DB: other }, admin: { username: "cs" } },
  } as never);
  assert.notEqual(physical.status, 200);
});

test("the lead list filters by product kind and counts each kind over the whole queue", async () => {
  const { sqlite, database } = seed();
  sqlite.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district,
      total_amount, created_at, payment_method, payment_status, shipping_status)
      VALUES (8, 'ABN-10008', 1, 'Sari', '6281234567891', '', '', '', '', 50000, '2026-11-28T00:00:00.000Z', 'cod', 'unpaid', 'abandoned'),
             (9, 'ABN-10009', 1, 'Tanpa Produk', '6281234567892', '', '', '', '', 0, '2026-11-28T00:00:00.000Z', 'cod', 'unpaid', 'abandoned');
    INSERT INTO order_items (order_id, variant_id, quantity, unit_price) VALUES (8, 11, 1, 50000);
  `);
  const { GET: listLeads } = await import("../pages/api/admin/abandoned-orders.ts");
  const list = async (query: string) => {
    const response = await listLeads({
      url: new URL(`https://toko.test/api/admin/abandoned-orders?${query}`),
      locals: { tenantDb: database, runtimeEnv: { OMS_DB: database } },
      request: new Request("https://toko.test/api/admin/abandoned-orders"),
    } as never);
    return { status: response.status, body: (await response.json()) as { data?: Array<{ order_number: string; product_type: string | null }>; kind_counts?: { physical: number; digital: number } } };
  };
  const all = await list("");
  assert.deepEqual(all.body.data?.map((row) => [row.order_number, row.product_type]), [["ABN-10009", null], ["ABN-10008", "physical"], ["ABN-10007", "digital"]]);
  assert.deepEqual(all.body.kind_counts, { physical: 1, digital: 1 });
  assert.deepEqual((await list("fulfillment=digital")).body.data?.map((row) => row.order_number), ["ABN-10007"]);
  assert.deepEqual((await list("fulfillment=physical")).body.data?.map((row) => row.order_number), ["ABN-10008"]);
  assert.deepEqual((await list("fulfillment=physical")).body.kind_counts, { physical: 1, digital: 1 }, "the counts ignore the kind filter, like the status chips");
  assert.equal((await list("fulfillment=services")).status, 400);
});

test("a digital order's page edits only the buyer: address, courier and waybill are refused", async () => {
  const { sqlite, database } = seed();
  await convertDigitalLead(database, 7, digitalInput);
  const { PATCH } = await import("../pages/api/admin/orders/[id].ts");
  const patch = (body: Record<string, unknown>) =>
    PATCH({
      params: { id: "7" },
      request: new Request("https://toko.test/api/admin/orders/7", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      locals: { tenantDb: database, runtimeEnv: {}, admin: { username: "owner", role: "owner" } },
    } as never);
  for (const body of [
    { address: "Jalan Merdeka Nomor 10" },
    { district: "Coblong", city: "Bandung", province: "Jawa Barat" },
    { destination_area_id: "area-1" },
    { courier_code: "jne" },
    { courier_service_id: 1 },
    { cnote_no: "AWB-1" },
    { shipping_channel: "external" },
  ]) {
    const response = await patch(body);
    // A courier id alone is already refused earlier as "no change" (400); everything else meets the digital guard.
    assert.equal(response.status, "courier_service_id" in body ? 400 : 422, JSON.stringify(body));
  }
  const renamed = await patch({ customer_name: "Budi Pratama", customer_phone: "081299998888" });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  const order = sqlite.prepare("SELECT customer_name, customer_phone, address, courier_code FROM orders WHERE id = 7").get() as Record<string, string | null>;
  assert.deepEqual({ ...order }, { customer_name: "Budi Pratama", customer_phone: "6281299998888", address: "-", courier_code: null });
});

test("a paid digital order is refunded from its page: the body the button sends voids it and closes the access", async () => {
  const { sqlite, database } = seed();
  await convertDigitalLead(database, 7, digitalInput);
  // Paid and delivered, as the paid transition leaves a digital order.
  sqlite.exec("UPDATE orders SET payment_status = 'paid', shipping_status = 'delivered' WHERE id = 7");
  const opened = sqlite.prepare("SELECT * FROM orders WHERE id = 7").get() as Record<string, string>;
  assert.equal(digitalAccessOpen(opened as never), true);
  const { PATCH } = await import("../pages/api/admin/orders/[id].ts");
  const response = await PATCH({
    params: { id: "7" },
    request: new Request("https://toko.test/api/admin/orders/7", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ payment_status: "refunded", shipping_status: "cancelled" }) }),
    locals: { tenantDb: database, runtimeEnv: {}, admin: { username: "owner", role: "owner" } },
  } as never);
  assert.equal(response.status, 200, await response.clone().text());
  const closed = sqlite.prepare("SELECT * FROM orders WHERE id = 7").get() as Record<string, string>;
  assert.deepEqual([closed.payment_status, closed.shipping_status], ["refunded", "cancelled"]);
  assert.equal(digitalAccessOpen(closed as never), false, "the buyer's link is closed");
});
