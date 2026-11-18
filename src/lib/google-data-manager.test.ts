import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createSqliteD1, type SqliteD1 } from "../platform/testing/sqlite-d1.ts";
import { grantsAdUserDataByDefault, EEA_UK_CH_REGIONS } from "./google-consent-regions.ts";
import {
  DATA_MANAGER_INGEST_URL,
  buildDataManagerRequest,
  buildGoogleUserIdentifiers,
  consentedUserIdentifiers,
  decideDataManagerRetry,
  type GoogleConversionRecord,
} from "./google-data-manager.ts";
import {
  buildGoogleConversionRecord,
  drainGoogleAdsConversionOutbox,
  readGoogleAdsOfflineConfig,
  reconcileGoogleAdsConversions,
  testGoogleAdsOfflineConnection,
  type GoogleAdsOfflineConfig,
} from "./google-ads-offline.ts";
import { splitMigrationStatements } from "./schema-version.ts";
import { captureMetaOrderContext, serializeMetaOrderContext } from "./meta-order-context.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const MINUTE = 60_000;
const SITE = "https://toko.adsbook.my.id";

const DM_CONFIG: GoogleAdsOfflineConfig = {
  customerId: "1234567890",
  conversionActionId: "987654321",
  loginCustomerId: "1122334455",
  developerToken: "",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  startAt: "2026-11-01T00:00:00.000Z",
  mode: "data_manager",
  codTrigger: "delivered",
};

// ---- Identifiers: one union element each, Google's normalisation ----

test("user identifiers are separate union elements: +62 phone, real email, and a complete address only", async () => {
  const identifiers = await buildGoogleUserIdentifiers({
    phone: "0812-3456-7890",
    email: " Siti.Rahayu@Example.COM ",
    name: "Siti  Nur-Rahayu",
    postalCode: "40135",
  });
  assert.deepEqual(identifiers, [
    { phoneNumber: sha("+6281234567890") },
    { emailAddress: sha("siti.rahayu@example.com") },
    { address: { givenName: sha("siti"), familyName: sha("nurrahayu"), regionCode: "ID", postalCode: "40135" } },
  ]);
  for (const identifier of identifiers) assert.equal(Object.keys(identifier).length, 1, "exactly one field per UserIdentifier");
  assert.notEqual(identifiers[0], { phoneNumber: sha("6281234567890") });
  // AddressInfo needs all four fields: a one-word name or a missing postal code drops the address only.
  const oneWord = await buildGoogleUserIdentifiers({ phone: "081234567890", name: "Rina", postalCode: "40135" });
  assert.deepEqual(oneWord.map((item) => Object.keys(item)[0]), ["phoneNumber"]);
  const noPostal = await buildGoogleUserIdentifiers({ name: "Rina Lestari" });
  assert.deepEqual(noPostal, []);
});

test("consent follows the storefront's Consent Mode: a known non-EEA country only", async () => {
  assert.equal(grantsAdUserDataByDefault("ID"), true);
  assert.equal(grantsAdUserDataByDefault("id"), true);
  for (const code of ["DE", "GB", "CH", "NO", "FR"]) assert.equal(grantsAdUserDataByDefault(code), false, code);
  for (const unknown of [undefined, null, "", "XX", "T1", "IDN"]) assert.equal(grantsAdUserDataByDefault(unknown as string), false, String(unknown));
  assert.equal(EEA_UK_CH_REGIONS.length, 32);
  const storefront = readFileSync("src/components/storefront/tracking/GoogleAdsBase.astro", "utf8");
  assert.match(storefront, /consentDeniedRegions: \[\.\.\.EEA_UK_CH_REGIONS\]/, "the browser and the server read one list");
  const eea = await consentedUserIdentifiers("DE", { phone: "081234567890" });
  assert.deepEqual(eea, { consentGranted: false, userIdentifiers: [] });
  const indonesia = await consentedUserIdentifiers("ID", { phone: "081234567890" });
  assert.equal(indonesia.consentGranted, true);
  assert.equal(indonesia.userIdentifiers.length, 1);
});

// ---- The events:ingest body ----

const RECORD: GoogleConversionRecord = {
  v: 2,
  orderNumber: "INV-10042",
  eventTime: "2026-11-18T12:00:00.000Z",
  value: 149000,
  currency: "IDR",
  gclid: "Cj0KCQ_click",
  wbraid: "WB_1",
  consentGranted: true,
  userIdentifiers: [{ phoneNumber: sha("+6281234567890") }],
};

test("the ingest body: Google Ads destination, one click id, consent and HEX-encoded user data", () => {
  assert.deepEqual(buildDataManagerRequest(RECORD, DM_CONFIG), {
    destinations: [{
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" },
      loginAccount: { accountType: "GOOGLE_ADS", accountId: "1122334455" },
      productDestinationId: "987654321",
    }],
    events: [{
      transactionId: "INV-10042",
      eventTimestamp: "2026-11-18T12:00:00.000Z",
      eventSource: "WEB",
      currency: "IDR",
      conversionValue: 149000,
      adIdentifiers: { gclid: "Cj0KCQ_click" },
      consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
      userData: { userIdentifiers: [{ phoneNumber: sha("+6281234567890") }] },
    }],
    encoding: "HEX",
  });
  // Without consent: click id and value only, no consent block, no user data, no encoding.
  const eea = buildDataManagerRequest({ ...RECORD, consentGranted: false }, { ...DM_CONFIG, loginCustomerId: undefined });
  assert.deepEqual(Object.keys(eea).sort(), ["destinations", "events"]);
  assert.equal("loginAccount" in eea.destinations[0], false);
  assert.equal("userData" in eea.events[0], false);
  assert.equal("consent" in eea.events[0], false);
  assert.equal(buildDataManagerRequest(RECORD, DM_CONFIG, { validateOnly: true }).validateOnly, true);
});

test("Data Manager answers: 5xx retries before any 4xx rule, 409 is already held, 401/403 is the account's", () => {
  assert.deepEqual(decideDataManagerRetry({ httpStatus: 200 }, 0, 5), { status: "sent", delayMs: 0 });
  assert.deepEqual(decideDataManagerRetry({ httpStatus: 503, errorStatus: "INVALID_ARGUMENT" }, 0, 5), { status: "pending", delayMs: 2 * MINUTE });
  assert.deepEqual(decideDataManagerRetry({ httpStatus: 0 }, 1, 5), { status: "pending", delayMs: 4 * MINUTE });
  assert.deepEqual(decideDataManagerRetry({ httpStatus: 429 }, 0, 5), { status: "pending", delayMs: 15 * MINUTE });
  assert.equal(decideDataManagerRetry({ httpStatus: 409 }, 0, 5).status, "sent");
  assert.equal(decideDataManagerRetry({ httpStatus: 400, errorStatus: "ALREADY_EXISTS" }, 0, 5).status, "sent");
  assert.equal(decideDataManagerRetry({ httpStatus: 403 }, 0, 5).status, "account");
  assert.equal(decideDataManagerRetry({ httpStatus: 401 }, 0, 5).status, "account");
  assert.equal(decideDataManagerRetry({ httpStatus: 400, errorStatus: "INVALID_ARGUMENT" }, 0, 5).status, "failed");
  assert.equal(decideDataManagerRetry({ httpStatus: 503 }, 4, 5).status, "failed", "the attempt budget still ends it");
});

// ---- Config: no developer token on the Data Manager path ----

test("the Data Manager API needs no developer token; the Ads API path still does", () => {
  const row = {
    google_ads_customer_id: "123-456-7890",
    google_ads_offline_conversion_action_id: "987654321",
    google_ads_client_id: "client-id",
    google_ads_client_secret: "client-secret",
    google_ads_refresh_token: "refresh-token",
    google_ads_offline_start_at: "2026-11-01T00:00:00.000Z",
  };
  assert.equal(readGoogleAdsOfflineConfig({ ...row, google_ads_api_mode: "data_manager" })?.mode, "data_manager");
  assert.equal(readGoogleAdsOfflineConfig({ ...row, google_ads_api_mode: "ads_api" }), null);
  assert.equal(readGoogleAdsOfflineConfig({ ...row, google_ads_api_mode: "ads_api", google_ads_developer_token: "dev" })?.mode, "ads_api");
  assert.equal(readGoogleAdsOfflineConfig({ ...row, google_ads_cod_trigger: "order_created" })?.codTrigger, "order_created");
});

// ---- Migration 0083 on a real SQLite ----

const migration = (suffix: string) => {
  const name = readdirSync("src/db/migrations").find((file) => file.endsWith(suffix));
  assert.ok(name, suffix);
  return readFileSync(`src/db/migrations/${name}`, "utf8");
};

function storeWithOutbox(developerToken: string | null): SqliteD1 {
  const database = createSqliteD1();
  database.sqlite.exec(`
    CREATE TABLE stores (id INTEGER PRIMARY KEY, google_ads_developer_token TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, order_number TEXT NOT NULL, payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL, shipping_status TEXT NOT NULL, created_at TEXT NOT NULL, ad_click_ids TEXT,
      stock_restored_at TEXT, customer_phone TEXT, customer_email TEXT, customer_name TEXT, postal_code TEXT,
      meta_request_context TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL);
  `);
  database.sqlite.prepare("INSERT INTO stores (id, google_ads_developer_token) VALUES (1, ?)").run(developerToken);
  database.sqlite.exec(migration("_google_ads_conversion_outbox.sql").replaceAll("--> statement-breakpoint", ""));
  return database;
}

function applyGoogleDataManagerMigration(database: SqliteD1) {
  for (const statement of splitMigrationStatements(migration("_google_data_manager_and_trigger.sql"))) database.sqlite.exec(statement);
}

test("migration 0083: a store with a developer token stays on the Ads API, queued rows survive, cod_created is allowed", () => {
  const legacy = storeWithOutbox("dev-token");
  legacy.sqlite.exec(`INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, created_at) VALUES (1, 'INV-1', 'cod', 'unpaid', 'delivered', 't')`);
  legacy.sqlite.exec(`INSERT INTO google_ads_conversion_outbox (order_id, order_number, qualification, payload, next_retry_at, created_at, updated_at)
    VALUES (1, 'INV-1', 'cod_delivered', '{"orderId":"INV-1"}', 'n', 'c', 'u')`);
  applyGoogleDataManagerMigration(legacy);
  assert.deepEqual({ ...legacy.sqlite.prepare("SELECT google_ads_api_mode, google_ads_cod_trigger FROM stores").get() }, { google_ads_api_mode: "ads_api", google_ads_cod_trigger: "delivered" });
  assert.deepEqual({ ...legacy.sqlite.prepare("SELECT order_number, qualification, payload FROM google_ads_conversion_outbox").get() }, { order_number: "INV-1", qualification: "cod_delivered", payload: '{"orderId":"INV-1"}' });
  legacy.sqlite.exec(`INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, created_at) VALUES (2, 'INV-2', 'cod', 'unpaid', 'pending', 't')`);
  legacy.sqlite.exec(`INSERT INTO google_ads_conversion_outbox (order_id, order_number, qualification, payload, next_retry_at, created_at, updated_at) VALUES (2, 'INV-2', 'cod_created', '{}', 'n', 'c', 'u')`);
  assert.throws(() => legacy.sqlite.exec(`INSERT INTO google_ads_conversion_outbox (order_id, order_number, qualification, payload, next_retry_at, created_at, updated_at) VALUES (2, 'INV-2', 'other', '{}', 'n', 'c', 'u')`));
  const fresh = storeWithOutbox(null);
  applyGoogleDataManagerMigration(fresh);
  assert.equal((fresh.sqlite.prepare("SELECT google_ads_api_mode FROM stores").get() as { google_ads_api_mode: string }).google_ads_api_mode, "data_manager");
});

// ---- Reconcile: the COD trigger and the consent gate ----

function addOrder(database: SqliteD1, id: number, fields: Record<string, string | null>) {
  const row = {
    order_number: `INV-${10000 + id}`, payment_method: "cod", payment_status: "unpaid", shipping_status: "pending",
    created_at: "2026-11-10T08:00:00.000Z", ad_click_ids: JSON.stringify({ gclid: "Cj0KCQ_click" }),
    customer_phone: "081234567890", customer_email: null, customer_name: "Rina Lestari", postal_code: "40135",
    meta_request_context: JSON.stringify({ country: "ID" }), stock_restored_at: null, ...fields,
  };
  const columns = Object.keys(row);
  database.sqlite.prepare(`INSERT INTO orders (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`).run(id, ...Object.values(row));
  database.sqlite.prepare("INSERT INTO order_items (order_id, unit_price, quantity) VALUES (?, 149000, 1)").run(id);
}

const queued = (database: SqliteD1) =>
  (database.sqlite.prepare("SELECT order_number, qualification, payload FROM google_ads_conversion_outbox ORDER BY id").all() as Array<{ order_number: string; qualification: string; payload: string }>)
    .map((row) => ({ ...row, record: JSON.parse(row.payload) as GoogleConversionRecord }));

test("the COD trigger: delivered keeps a pending order back; order_created queues it at its creation time", async () => {
  const observed = new Date("2026-11-18T12:00:00.000Z");
  const delivered = storeWithOutbox(null);
  applyGoogleDataManagerMigration(delivered);
  addOrder(delivered, 1, {});
  addOrder(delivered, 2, { shipping_status: "delivered" });
  assert.equal(await reconcileGoogleAdsConversions(delivered, DM_CONFIG, observed, SITE), 1);
  assert.deepEqual(queued(delivered).map((row) => [row.order_number, row.qualification, row.record.eventTime]), [["INV-10002", "cod_delivered", observed.toISOString()]]);

  const created = storeWithOutbox(null);
  applyGoogleDataManagerMigration(created);
  addOrder(created, 1, {});
  addOrder(created, 2, { shipping_status: "cancelled" });
  addOrder(created, 3, { shipping_status: "abandoned" });
  addOrder(created, 4, { stock_restored_at: "2026-11-11" });
  assert.equal(await reconcileGoogleAdsConversions(created, { ...DM_CONFIG, codTrigger: "order_created" }, observed, SITE), 1);
  assert.deepEqual(queued(created).map((row) => [row.order_number, row.qualification, row.record.eventTime]), [["INV-10001", "cod_created", "2026-11-10T08:00:00.000Z"]]);
});

test("the consent gate on a real order: Indonesia carries hashed identifiers, EEA and unknown carry none", async () => {
  const observed = new Date("2026-11-18T12:00:00.000Z");
  const database = storeWithOutbox(null);
  applyGoogleDataManagerMigration(database);
  addOrder(database, 1, { shipping_status: "delivered", customer_email: "6281234567890@toko.adsbook.my.id" });
  addOrder(database, 2, { shipping_status: "delivered", meta_request_context: JSON.stringify({ country: "DE" }) });
  addOrder(database, 3, { shipping_status: "delivered", meta_request_context: null });
  await reconcileGoogleAdsConversions(database, DM_CONFIG, observed, SITE);
  const [indonesia, germany, unknown] = queued(database).map((row) => row.record);
  assert.equal(indonesia.consentGranted, true);
  assert.deepEqual(indonesia.userIdentifiers?.map((item) => Object.keys(item)[0]), ["phoneNumber", "address"], "the provider-minted email is never sent");
  assert.doesNotMatch(JSON.stringify(indonesia), /0812|Rina/i, "the outbox holds hashes only");
  for (const record of [germany, unknown]) {
    assert.equal(record.consentGranted, false);
    assert.equal(record.userIdentifiers, undefined);
  }
  // The same rule decides the built record directly.
  const built = await buildGoogleConversionRecord({ id: 9, order_number: "INV-9", payment_method: "qris", payment_status: "paid", shipping_status: "pending", created_at: "t", ad_click_ids: JSON.stringify({ wbraid: "WB" }), product_value: 1 }, "delivered", observed);
  assert.equal(built?.qualification, "online_paid");
  assert.equal(built?.record.consentGranted, false);
});

// ---- Drain and the validateOnly test ----

test("a Data Manager drain posts events:ingest with the access token, and drains a row queued before 0083", async (context) => {
  const database = storeWithOutbox(null);
  applyGoogleDataManagerMigration(database);
  addOrder(database, 1, { shipping_status: "delivered" });
  addOrder(database, 2, { shipping_status: "delivered" });
  await reconcileGoogleAdsConversions(database, DM_CONFIG, new Date("2026-11-18T12:00:00.000Z"), SITE);
  // Order 2's row rewritten into the pre-0083 Ads API shape.
  database.sqlite.prepare("UPDATE google_ads_conversion_outbox SET payload = ? WHERE order_number = 'INV-10002'").run(JSON.stringify({
    conversionAction: "customers/1234567890/conversionActions/987654321", conversionDateTime: "2026-11-15 10:00:00+00:00",
    conversionValue: 149000, currencyCode: "IDR", orderId: "INV-10002", gclid: "Cj0KCQ_old",
  }));
  database.sqlite.exec("UPDATE google_ads_conversion_outbox SET next_retry_at = '2000-01-01T00:00:00.000Z'");
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") });
    if (String(url).includes("oauth2")) return Response.json({ access_token: "access-123" });
    return Response.json({ requestId: "req-1" });
  }) as typeof fetch;
  assert.equal(await drainGoogleAdsConversionOutbox(database, DM_CONFIG), 2);
  const ingests = requests.filter((request) => request.url === DATA_MANAGER_INGEST_URL);
  assert.equal(ingests.length, 2);
  assert.equal(ingests[0].headers.Authorization, "Bearer access-123");
  assert.equal("developer-token" in ingests[0].headers, false, "no developer token on this path");
  const fresh = JSON.parse(ingests[0].body);
  assert.equal(fresh.encoding, "HEX");
  assert.equal(fresh.events[0].userData.userIdentifiers[0].phoneNumber, sha("+6281234567890"));
  const legacy = JSON.parse(ingests[1].body);
  assert.deepEqual(legacy.events[0].adIdentifiers, { gclid: "Cj0KCQ_old" });
  assert.equal(legacy.events[0].eventTimestamp, "2026-11-15T10:00:00.000Z");
  assert.equal("userData" in legacy.events[0], false);
  const statuses = database.sqlite.prepare("SELECT status FROM google_ads_conversion_outbox").all() as Array<{ status: string }>;
  assert.deepEqual(statuses.map((row) => row.status), ["sent", "sent"]);
});

test("Uji koneksi: validateOnly on the Data Manager API, token refresh only on the Ads API", async (context) => {
  const bodies: string[] = [];
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("oauth2")) return Response.json({ access_token: "access-123" });
    bodies.push(String(init?.body ?? ""));
    return Response.json({ requestId: "req-validate" });
  }) as typeof fetch;
  const ok = await testGoogleAdsOfflineConnection(DM_CONFIG);
  assert.equal(ok.ok, true);
  const body = JSON.parse(bodies[0]);
  assert.equal(body.validateOnly, true, "Google validates and records nothing");
  assert.equal(body.destinations[0].productDestinationId, "987654321");
  const legacy = await testGoogleAdsOfflineConnection({ ...DM_CONFIG, mode: "ads_api", developerToken: "dev" });
  assert.equal(legacy.ok, true);
  assert.equal(bodies.length, 1, "the Ads API test sends no conversion");
  globalThis.fetch = (async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 })) as typeof fetch;
  const refused = await testGoogleAdsOfflineConnection(DM_CONFIG);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /OAuth gagal/);
  assert.doesNotMatch(refused.message, /client-secret|refresh-token/, "never a credential in the message");
});

// ---- Review 2026-11-18 ----

test("review finding 1: a headless checkout's server country is not the buyer's, so no user data or consent is sent", async () => {
  const request = new Request("https://toko.adsbook.my.id/api/v1/checkout", { method: "POST", headers: { "cf-ipcountry": "ID" } });
  assert.equal(captureMetaOrderContext(request).country, "ID", "the buyer's own browser: the country is theirs");
  const headless = captureMetaOrderContext(request, { buyerDirect: false });
  assert.equal(headless.country, undefined, "a server-to-server call records no country");
  const checkout = readFileSync("src/pages/api/v1/checkout.ts", "utf8");
  assert.match(checkout, /captureMetaOrderContext\(request, \{ buyerDirect: false \}\)/, "/api/v1/checkout passes buyerDirect: false");
  const built = await buildGoogleConversionRecord({
    id: 1, order_number: "INV-1", payment_method: "cod", payment_status: "unpaid", shipping_status: "delivered",
    created_at: "2026-11-10T08:00:00.000Z", ad_click_ids: JSON.stringify({ gclid: "Cj0KCQ_click" }), product_value: 149000,
    customer_phone: "081234567890", customer_name: "Rina Lestari", postal_code: "40135",
    meta_request_context: serializeMetaOrderContext(headless) ?? null,
  }, "delivered", new Date("2026-11-18T12:00:00.000Z"));
  assert.equal(built?.record.consentGranted, false);
  assert.equal(built?.record.userIdentifiers, undefined);
  const body = buildDataManagerRequest(built!.record, DM_CONFIG);
  assert.equal("consent" in body.events[0], false);
  assert.equal("userData" in body.events[0], false);
  assert.equal("encoding" in body, false);
});

test("review finding 2: the outbox rebuild keeps the AUTOINCREMENT high-water mark, so a purged id is never reused", () => {
  const nextId = (database: SqliteD1) => {
    database.sqlite.exec(`INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, created_at) VALUES (900, 'INV-900', 'cod', 'unpaid', 'delivered', 't')`);
    database.sqlite.exec(`INSERT INTO google_ads_conversion_outbox (order_id, order_number, qualification, payload, next_retry_at, created_at, updated_at) VALUES (900, 'INV-900', 'cod_delivered', '{}', 'n', 'c', 'u')`);
    return (database.sqlite.prepare("SELECT MAX(id) AS id FROM google_ads_conversion_outbox").get() as { id: number }).id;
  };
  // Row 50 issued, then purged: the table is empty but 50 was handed out.
  const purged = storeWithOutbox(null);
  purged.sqlite.exec(`INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, created_at) VALUES (1, 'INV-1', 'cod', 'unpaid', 'delivered', 't')`);
  purged.sqlite.exec(`INSERT INTO google_ads_conversion_outbox (id, order_id, order_number, qualification, payload, next_retry_at, created_at, updated_at) VALUES (50, 1, 'INV-1', 'cod_delivered', '{}', 'n', 'c', 'u')`);
  purged.sqlite.exec("DELETE FROM google_ads_conversion_outbox");
  applyGoogleDataManagerMigration(purged);
  assert.equal(nextId(purged), 51);
  // Rows kept below a higher purged mark: still above the mark.
  const partial = storeWithOutbox(null);
  for (const id of [1, 2]) partial.sqlite.exec(`INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, created_at) VALUES (${id}, 'INV-${id}', 'cod', 'unpaid', 'delivered', 't')`);
  partial.sqlite.exec(`INSERT INTO google_ads_conversion_outbox (id, order_id, order_number, qualification, payload, next_retry_at, created_at, updated_at) VALUES (7, 1, 'INV-1', 'cod_delivered', '{}', 'n', 'c', 'u'), (80, 2, 'INV-2', 'cod_delivered', '{}', 'n', 'c', 'u')`);
  partial.sqlite.exec("DELETE FROM google_ads_conversion_outbox WHERE id = 80");
  applyGoogleDataManagerMigration(partial);
  assert.equal(nextId(partial), 81);
  // A table that never issued an id starts at 1, as before.
  const fresh = storeWithOutbox(null);
  applyGoogleDataManagerMigration(fresh);
  assert.equal(nextId(fresh), 1);
  const names = fresh.sqlite.prepare("SELECT name FROM sqlite_sequence ORDER BY name").all() as Array<{ name: string }>;
  assert.equal(names.some((row) => row.name.endsWith("_new")), false, "no stray counter left behind");
});

