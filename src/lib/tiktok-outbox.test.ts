import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createSqliteD1, type SqliteD1 } from "../platform/testing/sqlite-d1.ts";
import { withTestCredentials } from "../platform/testing/credentials.ts";
import { sealCredential } from "./credential-crypto.ts";
import { serializeClickIds } from "./click-ids.ts";
import { enqueuePurchaseForPaidOrder, scheduleCodPurchase } from "./paid-order-purchase.ts";
import { splitMigrationStatements } from "./schema-version.ts";
import {
  drainTikTokOutbox,
  enqueueTikTokCompletePayment,
  enqueueTikTokEvent,
  readTikTokOutboxDepth,
  requeueRecoverableTikTokEvents,
  sweepTikTokCompletePayments,
  tiktokOrderQualifies,
} from "./tiktok-outbox.ts";
import type { TikTokEventData } from "./tiktok-events.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PIXEL = "C4ABCDEFGHIJ1234";
const TOKEN = "tiktok-token-rahasia-001";
const SITE = "https://toko.adsbook.my.id";

/** A real SQLite with migration 0082 applied as written, on the columns it extends. */
async function store(options: { trigger?: "order_created" | "delivered"; token?: boolean; bound?: boolean } = {}) {
  const database = createSqliteD1();
  database.sqlite.exec(`
    CREATE TABLE stores (id INTEGER PRIMARY KEY, meta_pixel_id TEXT, meta_capi_token TEXT, google_tag_manager_id TEXT,
      google_ads_conversion_id TEXT, google_ads_conversion_label TEXT);
    INSERT INTO stores (id) VALUES (1);
    CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE product_variants (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, order_number TEXT NOT NULL, payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL, shipping_status TEXT NOT NULL, stock_restored_at TEXT, customer_name TEXT,
      customer_phone TEXT, customer_email TEXT, province TEXT, city TEXT, postal_code TEXT,
      ad_click_ids TEXT, meta_request_context TEXT, created_at TEXT NOT NULL);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, variant_id INTEGER NOT NULL,
      unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL);
    INSERT INTO products (id, title) VALUES (10012, 'Paket Serum Brightening');
    INSERT INTO product_variants (id, product_id) VALUES (1, 10012);
  `);
  // Found by suffix, never by number: integration renumbers the chain.
  const migration = readdirSync("src/db/migrations").find((name) => name.endsWith("_tiktok_ads_tracking.sql"));
  assert.ok(migration, "the TikTok migration exists");
  for (const statement of splitMigrationStatements(readFileSync(`src/db/migrations/${migration}`, "utf8"))) {
    database.sqlite.exec(statement);
  }
  if (options.bound !== false) withTestCredentials(database);
  // A keyless handle still gets a correctly sealed value (same test tenant), so
  // the test proves the handle cannot open it, not that nothing was stored.
  const sealer = options.bound === false ? withTestCredentials(createSqliteD1()) : database;
  const sealed = options.token === false ? null : await sealCredential(sealer, "tiktok_access_token", TOKEN);
  database.sqlite.prepare("UPDATE stores SET tiktok_pixel_id = ?, tiktok_access_token = ?, tiktok_cod_trigger = ?").run(
    PIXEL,
    sealed,
    options.trigger ?? "order_created",
  );
  return database;
}

function addOrder(
  database: SqliteD1,
  id: number,
  fields: Partial<{ payment_method: string; payment_status: string; shipping_status: string; stock_restored_at: string | null; created_at: string; ad_click_ids: string | null; meta_request_context: string | null }> = {},
) {
  database.sqlite
    .prepare(
      `INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, stock_restored_at,
         customer_name, customer_phone, customer_email, province, city, postal_code, ad_click_ids, meta_request_context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Siti Rahayu', '081234567890', NULL, 'Jawa Barat', 'Bandung', '40115', ?, ?, ?)`,
    )
    .run(
      id,
      `INV-${10000 + id}`,
      fields.payment_method ?? "cod",
      fields.payment_status ?? "unpaid",
      fields.shipping_status ?? "pending",
      fields.stock_restored_at ?? null,
      fields.ad_click_ids === undefined ? serializeClickIds({ ttclid: "E_C_P_123" }) : fields.ad_click_ids,
      fields.meta_request_context === undefined
        ? JSON.stringify({ externalId: "0123456789abcdef0123456789abcdef", clientIp: "203.0.113.10", userAgent: "Mozilla/5.0", ttp: "AbCdEfGhIjKlMnOpQrStUvWxYz0" })
        : fields.meta_request_context,
      fields.created_at ?? new Date().toISOString(),
    );
  database.sqlite.prepare("INSERT INTO order_items (order_id, variant_id, unit_price, quantity) VALUES (?, 1, 149000, 1)").run(id);
}

function recordingFetch(answer: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ headers: Record<string, string>; body: { event_source_id: string; test_event_code?: string; data: TikTokEventData[] } }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return Response.json(answer.body ?? { code: 0, message: "OK" }, { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const locals = (database: SqliteD1, paused = false) =>
  ({
    tenantDb: database,
    tenant: { siteUrl: SITE },
    ...(paused ? { billing: { state: "preview", adSignalsPaused: true } } : {}),
  }) as unknown as App.Locals;

const outbox = (database: SqliteD1) =>
  database.sqlite.prepare("SELECT event_name, event_id, status, attempts, last_error, payload FROM tiktok_event_outbox ORDER BY id").all() as Array<{
    event_name: string; event_id: string; status: string; attempts: number; last_error: string | null; payload: string;
  }>;

// ---- When an order is a CompletePayment ----

test("COD qualifies at creation by default, or only once delivered when the seller chose that; online only once paid", () => {
  const cod = { payment_method: "cod", payment_status: "unpaid", shipping_status: "pending" };
  assert.equal(tiktokOrderQualifies(cod, "order_created"), true);
  assert.equal(tiktokOrderQualifies(cod, "delivered"), false);
  assert.equal(tiktokOrderQualifies({ ...cod, shipping_status: "delivered" }, "delivered"), true);
  const qris = { payment_method: "qris", payment_status: "unpaid", shipping_status: "pending" };
  assert.equal(tiktokOrderQualifies(qris, "order_created"), false, "never an unpaid online order");
  assert.equal(tiktokOrderQualifies({ ...qris, payment_status: "paid" }, "delivered"), true, "the COD trigger never touches online payments");
  assert.equal(tiktokOrderQualifies({ payment_method: "manual_transfer", payment_status: "settled", shipping_status: "pending" }, "order_created"), true);
  assert.equal(tiktokOrderQualifies({ ...cod, shipping_status: "cancelled" }, "order_created"), false, "never a void order");
  assert.equal(tiktokOrderQualifies({ ...cod, stock_restored_at: "2026-11-18" }, "order_created"), false);
  assert.equal(tiktokOrderQualifies({ ...cod, shipping_status: "abandoned" }, "order_created"), false, "never a lead");
});

// ---- The server leg of one order ----

test("a COD order sends CompletePayment once, keyed on its order number, matched on +62 phone, ttclid without UTM and _ttp", async () => {
  const database = await store();
  addOrder(database, 42);
  const { calls, fetchImpl } = recordingFetch();
  const result = await enqueueTikTokCompletePayment(database, locals(database), 42, { fetchImpl });
  assert.deepEqual(result, { status: "queued", delivered: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["Access-Token"], TOKEN, "the sealed token is opened for the call");
  assert.equal(calls[0].body.event_source_id, PIXEL);
  assert.equal(calls[0].body.test_event_code, undefined, "a live conversion never carries a test code");
  const [event] = calls[0].body.data;
  assert.equal(event.event, "CompletePayment");
  assert.equal(event.event_id, "INV-10042");
  assert.equal(event.user.phone, sha("+6281234567890"));
  assert.equal(event.user.ttclid, "E_C_P_123");
  assert.equal(event.user.ttp, "AbCdEfGhIjKlMnOpQrStUvWxYz0");
  assert.equal(event.user.external_id, sha("0123456789abcdef0123456789abcdef"));
  assert.deepEqual(event.properties, {
    currency: "IDR",
    value: 149000,
    content_type: "product",
    order_id: "INV-10042",
    contents: [{ content_id: "10012", content_name: "Paket Serum Brightening", price: 149000, quantity: 1 }],
  });
  assert.equal(event.page.url, `${SITE}/thanks`);
  // Replayed (the sweep, a second payment confirmation): the outbox key stops it.
  assert.deepEqual(await enqueueTikTokCompletePayment(database, locals(database), 42, { fetchImpl }), { status: "deduplicated" });
  assert.equal(calls.length, 1);
  assert.equal(outbox(database)[0].status, "sent");
  assert.doesNotMatch(outbox(database)[0].payload, /0812|6281234567890/, "the outbox never holds the phone in clear");
});

test("a funnel event cannot occupy a CompletePayment's order-number id (key is event_name + event_id)", async () => {
  const database = await store();
  addOrder(database, 43);
  const squatter = { event: "ViewContent", event_time: 1, event_id: "INV-10043", user: {}, properties: { currency: "IDR", value: 0, content_type: "product" }, page: { url: SITE } } as TikTokEventData;
  assert.equal(await enqueueTikTokEvent(database, squatter), true);
  const { fetchImpl } = recordingFetch();
  assert.equal((await enqueueTikTokCompletePayment(database, locals(database), 43, { fetchImpl })).status, "queued");
});

test("the delivered trigger holds a pending COD order back, and lets it through once delivered", async () => {
  const database = await store({ trigger: "delivered" });
  addOrder(database, 44);
  const { calls, fetchImpl } = recordingFetch();
  assert.deepEqual(await enqueueTikTokCompletePayment(database, locals(database), 44, { fetchImpl }), { status: "skipped", reason: "order-not-qualified" });
  database.sqlite.exec("UPDATE orders SET shipping_status = 'delivered' WHERE id = 44");
  assert.equal((await enqueueTikTokCompletePayment(database, locals(database), 44, { fetchImpl, eventTime: 1 })).status, "queued");
  assert.notEqual(calls[0].body.data[0].event_time, 1, "the sale is the delivery: an order-creation time does not apply");
});

test("ADR-041: a store in Preview Mode or past its grace stores and sends nothing", async () => {
  const database = await store();
  addOrder(database, 45);
  const { calls, fetchImpl } = recordingFetch();
  assert.deepEqual(await enqueueTikTokCompletePayment(database, locals(database, true), 45, { fetchImpl }), { status: "skipped", reason: "tiktok-not-configured" });
  assert.equal(await sweepTikTokCompletePayments(database, locals(database, true)), 0);
  assert.equal(calls.length, 0);
  assert.equal(outbox(database).length, 0);
});

test("ADR-040: the token is stored sealed, and a handle without the platform key sends nothing", async () => {
  const database = await store();
  const stored = (database.sqlite.prepare("SELECT tiktok_access_token FROM stores").get() as { tiktok_access_token: string }).tiktok_access_token;
  assert.match(stored, /^enc:v1:/);
  assert.equal(stored.includes(TOKEN), false);
  const keyless = await store({ bound: false });
  keyless.sqlite.prepare("UPDATE stores SET tiktok_access_token = ?").run(stored);
  addOrder(keyless, 46);
  const { calls, fetchImpl } = recordingFetch();
  assert.equal((await enqueueTikTokCompletePayment(keyless, locals(keyless), 46, { fetchImpl })).status, "skipped");
  assert.equal(calls.length, 0);
});

test("every existing order path reaches TikTok: COD at submit and a payment becoming paid, beside Meta", async () => {
  const database = await store();
  addOrder(database, 47, { payment_method: "qris", payment_status: "paid" });
  const { calls, fetchImpl } = recordingFetch();
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    // Meta is not configured here: its result is "skipped" and TikTok still goes.
    assert.equal((await enqueuePurchaseForPaidOrder(database, locals(database), 47)).status, "skipped");
    addOrder(database, 48);
    scheduleCodPurchase(database, locals(database), 48, "cod");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls.map((call) => call.body.data[0].event_id), ["INV-10047", "INV-10048"]);
});

// ---- Retry, requeue and the hourly net ----

test("TikTok's answers drive the row: rate limit waits, a dead token is terminal with its reason, a 5xx backs off", async () => {
  const cases: Array<[unknown, number, string, number]> = [
    [{ code: 40100, message: "Too many requests" }, 200, "pending", 1],
    [{ code: 40001, message: "No permission" }, 200, "failed", 1],
    [{ code: 50000, message: "Internal error" }, 200, "pending", 1],
  ];
  for (const [body, status, expected, attempts] of cases) {
    const database = await store();
    addOrder(database, 50);
    const { fetchImpl } = recordingFetch({ status, body });
    assert.equal((await enqueueTikTokCompletePayment(database, locals(database), 50, { fetchImpl })).status, "queued");
    const [row] = outbox(database);
    assert.equal(row.status, expected, JSON.stringify(body));
    assert.equal(row.attempts, attempts);
    assert.match(row.last_error ?? "", /code \d+/);
    assert.equal((row.last_error ?? "").includes(TOKEN), false, "the token never reaches last_error");
  }
});

test("requeue offers a failed row back and the drain then delivers it; depth counts what is owed", async () => {
  const database = await store();
  addOrder(database, 51);
  await enqueueTikTokCompletePayment(database, locals(database), 51, { fetchImpl: recordingFetch({ body: { code: 40001 } }).fetchImpl });
  assert.equal((await readTikTokOutboxDepth(database))?.failed, 1);
  assert.equal(await requeueRecoverableTikTokEvents(database), 1);
  const { calls, fetchImpl } = recordingFetch();
  assert.equal(await drainTikTokOutbox(database, { pixelId: PIXEL, accessToken: TOKEN }, new Date(), fetchImpl), 1);
  assert.equal(calls.length, 1);
  const depth = await readTikTokOutboxDepth(database);
  assert.deepEqual({ failed: depth?.failed, pending: depth?.pending, sent: depth?.sent }, { failed: 0, pending: 0, sent: 1 });
});

test("the hourly sweep finds a delivered COD order (delivered trigger) and a missed one (creation trigger)", async () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const delivered = await store({ trigger: "delivered" });
  addOrder(delivered, 60, { shipping_status: "delivered", created_at: "2026-11-10T08:00:00Z" });
  addOrder(delivered, 61, { shipping_status: "pending", created_at: "2026-11-10T08:00:00Z" });
  addOrder(delivered, 62, { shipping_status: "delivered", created_at: "2026-10-01T08:00:00Z" });
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch().fetchImpl;
  try {
    assert.equal(await sweepTikTokCompletePayments(delivered, locals(delivered), now), 1);
    assert.deepEqual(outbox(delivered).map((row) => row.event_id), ["INV-10060"], "only the recently delivered one");
    const created = await store();
    addOrder(created, 70, { created_at: "2026-11-18T10:00:00Z" });
    addOrder(created, 71, { created_at: "2026-11-18T11:50:00Z" });
    assert.equal(await sweepTikTokCompletePayments(created, locals(created), now), 1);
    assert.deepEqual(outbox(created).map((row) => row.event_id), ["INV-10070"], "a ten-minute-old order is left to submit and /thanks");
    const sent = JSON.parse(outbox(created)[0].payload) as TikTokEventData;
    assert.equal(sent.event_time, Math.floor(Date.parse("2026-11-18T10:00:00Z") / 1000), "the buyer bought when they ordered");
  } finally {
    globalThis.fetch = original;
  }
});
