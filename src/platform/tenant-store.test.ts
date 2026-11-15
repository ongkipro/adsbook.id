// T-18: the tenant store engine, the D1 adapter and the Worker-side migration
// protocol (MULTI-TENANT-DESIGN.md §4.4, docs/spec/15 MIG-1/MIG-2), on the
// real inherited chain in node:sqlite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { deleteOrdersReleasingReservations, updateAdminOrderShippingStatuses } from "../lib/order-lifecycle.ts";
import { persistOrder, recordAbandonedOrder } from "../lib/order-persistence.ts";
import { splitMigrationStatements } from "../lib/schema-version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import {
  applyMigrationFile,
  readLedger,
  TENANT_STORE_PROTOCOL,
  TenantStoreEngine,
  type MigrationFile,
  type SchemaState,
  type StoreKv,
} from "./store-core.ts";
import {
  createTenantDb,
  ensureTenantSchema,
  openTenantDb,
  TenantUnavailableError,
  type TenantStoreStub,
} from "./tenant-db.ts";
import { createNodeStorage } from "./testing/node-storage.ts";
import { createSqliteD1, type SqliteD1 } from "./testing/sqlite-d1.ts";

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

const N = CHAIN.length - 1; // release N bundles 0000…0078; release N+1 adds 0079

function memoryKv(): StoreKv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, get: (key) => values.get(key), put: (key, value) => void values.set(key, value), delete: (key) => void values.delete(key) };
}

/** A store as one Durable Object: one engine, single-threaded, structured-clone at the boundary. */
function objectFor(storage = createNodeStorage(), kv = memoryKv(), chain: readonly MigrationFile[] = CHAIN) {
  const engine = new TenantStoreEngine(storage, kv, chain, splitMigrationStatements);
  const calls: string[] = [];
  const hop = async <T>(name: string, run: () => T): Promise<T> => {
    calls.push(name);
    await new Promise((resolve) => setImmediate(resolve)); // another request may interleave here
    return structuredClone(run());
  };
  const stub: TenantStoreStub = {
    query: (protocol, statement, raw) => hop("query", () => (engine.checkProtocol(protocol), engine.query(structuredClone(statement), raw))),
    batch: (protocol, statements) => hop("batch", () => (engine.checkProtocol(protocol), engine.batch(structuredClone(statements)))),
    schemaState: (protocol) => hop("schemaState", () => (engine.checkProtocol(protocol), engine.schemaState())),
    prepareMigration: (protocol) => hop("prepareMigration", () => (engine.checkProtocol(protocol), { bookmark: `bm-${readLedger(storage).length}`, state: engine.schemaState() })),
    applyMigrations: (protocol, target, bookmarkId) => hop("applyMigrations", () => (engine.checkProtocol(protocol), engine.applyMigrations(target, bookmarkId))),
  };
  return { storage, kv, engine, stub, calls };
}

/** A store already at `files` of the chain, as a previous release left it. */
function storeAt(files: number) {
  const storage = createNodeStorage();
  for (const file of CHAIN.slice(0, files)) applyMigrationFile(storage, file, splitMigrationStatements);
  return storage;
}

async function platform(...tenants: string[]): Promise<SqliteD1> {
  const db = createSqliteD1();
  await ensureControlPlane(db, PLATFORM_CHAIN);
  for (const id of tenants) {
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, schema_version, created_at) VALUES (?, ?, ?, 'active', ?, '2026-11-16')").run(id, id, `${id}@example.test`, N);
  }
  return db;
}

const statusOf = (db: SqliteD1, id: string) => (db.sqlite.prepare("SELECT status, schema_version FROM tenants WHERE id = ?").get(id) as { status: string; schema_version: number });

test("two tenants migrate N → N+1 concurrently, each file applied once per tenant", async () => {
  const db = await platform("t-a", "t-b");
  const a = objectFor(storeAt(N));
  const b = objectFor(storeAt(N));
  // Three isolates per tenant (separate per-isolate maps) racing the same upgrade.
  const results = await Promise.all(
    [a, b].flatMap(({ stub }, index) =>
      [1, 2, 3].map(() => ensureTenantSchema(db, stub, index === 0 ? "t-a" : "t-b", CHAIN.length, { ready: new Map() })),
    ),
  );
  assert.ok(results.every((state) => state.applied === CHAIN.length));
  for (const store of [a, b]) {
    const ledger = readLedger(store.storage);
    assert.equal(ledger.length, CHAIN.length);
    assert.equal(new Set(ledger).size, ledger.length, "a file applied twice");
  }
  const bookmarks = db.sqlite.prepare("SELECT tenant_id, schema_version, COUNT(*) AS n FROM migration_bookmarks GROUP BY tenant_id, schema_version").all();
  assert.deepEqual(bookmarks.map((row) => ({ ...row })), [
    { tenant_id: "t-a", schema_version: N, n: 1 },
    { tenant_id: "t-b", schema_version: N, n: 1 },
  ]);
  assert.equal(statusOf(db, "t-a").schema_version, CHAIN.length);
  assert.equal(statusOf(db, "t-b").schema_version, CHAIN.length);
});

test("one isolate asks a ready tenant once, however many requests arrive", async () => {
  const db = await platform("t-a");
  const a = objectFor(storeAt(CHAIN.length));
  const ready = new Map<string, Promise<SchemaState>>();
  await Promise.all(Array.from({ length: 10 }, () => ensureTenantSchema(db, a.stub, "t-a", CHAIN.length, { ready })));
  assert.deepEqual(a.calls, ["schemaState"]);
});

test("a failed bookmark write starts no migration; a delayed one starts it only after the write", async () => {
  const failing = await platform("t-a");
  failing.failWhen = /migration_bookmarks/;
  const a = objectFor(storeAt(N));
  await assert.rejects(
    ensureTenantSchema(failing, a.stub, "t-a", CHAIN.length, { ready: new Map() }),
    (error: unknown) => error instanceof TenantUnavailableError && error.reason === "bookmark",
  );
  assert.equal(readLedger(a.storage).length, N, "migrated without a stored bookmark");
  assert.equal(a.calls.includes("applyMigrations"), false);

  const delayed = await platform("t-b");
  const b = objectFor(storeAt(N));
  const order: string[] = [];
  const original = delayed.prepare.bind(delayed);
  delayed.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!/migration_bookmarks/.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    return Object.assign(statement, {
      bind: (...values: unknown[]) => {
        const bound = bind(...values);
        return Object.assign(bound, {
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            order.push(`bookmark written (store at ${readLedger(b.storage).length})`);
            return original(sql).bind(...values).run();
          },
        });
      },
    });
  }) as typeof delayed.prepare;
  await ensureTenantSchema(delayed, b.stub, "t-b", CHAIN.length, { ready: new Map() });
  assert.deepEqual(order, [`bookmark written (store at ${N})`]);
  assert.equal(readLedger(b.storage).length, CHAIN.length);
});

test("a failing migration puts that tenant in recovery and leaves the other serving", async () => {
  const db = await platform("t-a", "t-b");
  const bad: MigrationFile = { name: `${String(CHAIN.length).padStart(4, "0")}_bad.sql`, sql: "CREATE TABLE half_done (id INTEGER);\nINSERT INTO nowhere VALUES (1);" };
  const a = objectFor(storeAt(CHAIN.length), memoryKv(), [...CHAIN, bad]);
  const b = objectFor(storeAt(CHAIN.length), memoryKv(), [...CHAIN, { name: bad.name, sql: "CREATE TABLE fine (id INTEGER);" }]);
  await assert.rejects(
    ensureTenantSchema(db, a.stub, "t-a", CHAIN.length + 1, { ready: new Map() }),
    (error: unknown) => error instanceof TenantUnavailableError && error.reason === "migration",
  );
  await ensureTenantSchema(db, b.stub, "t-b", CHAIN.length + 1, { ready: new Map() });
  assert.equal(statusOf(db, "t-a").status, "recovery");
  assert.equal(statusOf(db, "t-b").status, "active");
  const event = db.sqlite.prepare("SELECT kind, actor, detail_json FROM tenant_events WHERE tenant_id = 't-a'").get() as { kind: string; actor: string; detail_json: string };
  assert.equal(event.kind, "migration_failed");
  assert.match(event.detail_json, /nowhere/);
  // The failed file left nothing behind, and the other tenant still answers queries.
  assert.equal(readLedger(a.storage).length, CHAIN.length);
  assert.equal(a.storage.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()?.n, 0);
  assert.equal(await createTenantDb(b.stub).prepare("SELECT COUNT(*) AS n FROM fine").first("n"), 0);
  // No automatic retry while in recovery.
  await assert.rejects(
    ensureTenantSchema(db, a.stub, "t-a", CHAIN.length + 1, { ready: new Map() }),
    (error: unknown) => error instanceof TenantUnavailableError && error.reason === "recovery",
  );
});

test("a restored store restarts on its old schema, in recovery, and is not migrated again", async () => {
  const db = await platform("t-a");
  db.sqlite.exec("UPDATE tenants SET status = 'recovery' WHERE id = 't-a'");
  // What a PITR restore to the pre-migration bookmark leaves: release N's schema,
  // and the object's own copy of the guard (`rememberRestoreUndo`).
  const restored = memoryKv();
  const before = objectFor(storeAt(N), restored);
  before.engine.rememberRestoreUndo("bm-undo");
  // Restart: a new object over the same storage, constructor reads the ledger only.
  const restarted = objectFor(before.storage, restored);
  assert.equal(restarted.engine.schemaState().applied, N);
  await assert.rejects(
    ensureTenantSchema(db, restarted.stub, "t-a", CHAIN.length, { ready: new Map() }),
    (error: unknown) => error instanceof TenantUnavailableError && error.reason === "recovery",
  );
  assert.equal(readLedger(restarted.storage).length, N);
  assert.equal(restarted.calls.includes("applyMigrations"), false);
});

test("a rollback to release N keeps tenants already on N+1 serving", async () => {
  const db = await platform("t-a", "t-b");
  const a = objectFor(storeAt(CHAIN.length), memoryKv(), CHAIN.slice(0, N));
  const b = objectFor(storeAt(N), memoryKv(), CHAIN.slice(0, N));
  for (const [id, store] of [["t-a", a], ["t-b", b]] as const) {
    const state = await ensureTenantSchema(db, store.stub, id, N, { ready: new Map() });
    assert.ok(state.applied >= N);
    assert.equal(store.calls.includes("applyMigrations"), false, `${id} migrated on rollback`);
    assert.equal(await createTenantDb(store.stub).prepare("SELECT COUNT(*) AS n FROM orders").first("n"), 0);
  }
  // An unknown history is refused for that tenant only.
  const odd = objectFor(storeAt(3), memoryKv(), [CHAIN[0], CHAIN[1], { name: "0002_other.sql", sql: "SELECT 1;" }]);
  await assert.rejects(
    ensureTenantSchema(db, odd.stub, "t-b", 3, { ready: new Map() }),
    (error: unknown) => error instanceof TenantUnavailableError && error.reason === "history",
  );
});

test("a store on another protocol version is a 503 for its tenant, not a crash", async () => {
  const db = await platform("t-a");
  const stub: TenantStoreStub = {
    ...objectFor(storeAt(CHAIN.length)).stub,
    schemaState: async () => {
      throw new Error(`TENANT_STORE_PROTOCOL_MISMATCH: worker ${TENANT_STORE_PROTOCOL}, store ${TENANT_STORE_PROTOCOL + 1}`);
    },
  };
  await assert.rejects(
    ensureTenantSchema(db, stub, "t-a", CHAIN.length, { ready: new Map() }),
    (error: unknown) => error instanceof TenantUnavailableError && error.reason === "protocol",
  );
});

test("openTenantDb reaches the tenant's store by its id with the APAC hint, and refuses without bindings", async () => {
  const db = await platform("t-a");
  const store = objectFor(storeAt(CHAIN.length));
  const asked: unknown[] = [];
  const tenantDb = await openTenantDb(
    { PLATFORM_DB: db, TENANT_STORE: { getByName: (name: string, options: unknown) => (asked.push([name, options]), store.stub) } },
    "t-a",
    CHAIN.length,
    { ready: new Map() },
  );
  assert.deepEqual(asked, [["t-a", { locationHint: "apac-se" }]]);
  assert.equal(await tenantDb.prepare("SELECT COUNT(*) AS n FROM stores").first("n"), 0);
  await assert.rejects(openTenantDb({ PLATFORM_DB: db }, "t-a", CHAIN.length), TenantUnavailableError);
});

// ── The adapter against the real code (SPIKE-1 items 2 and 5, kept as tests) ──

test("the full chain replays to the schema the D1 test doubles build", () => {
  const storage = storeAt(CHAIN.length);
  const reference = createNodeStorage();
  for (const file of CHAIN) for (const statement of splitMigrationStatements(file.sql)) reference.db.exec(statement);
  const schema = (database: typeof storage.db) =>
    database
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name")
      .all()
      .map((row) => ({ ...row, sql: String((row as { sql: string | null }).sql ?? "").replace(/\s+/g, " ") }));
  assert.deepEqual(schema(storage.db), schema(reference.db));
});

test("meta.changes counts trigger writes; a batch is all or nothing; D1 binding rules hold", async () => {
  const store = objectFor(storeAt(CHAIN.length));
  const db = createTenantDb(store.stub);
  store.storage.db.exec(`
    INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'T', 't', '2026-11-01');
    INSERT INTO orders (order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, created_at)
    VALUES ('INV-1', 1, 'A', '62812', 'x', 'p', 'c', 'd', 1, '2026-11-01'), ('INV-2', 1, 'A', '62812', 'x', 'p', 'c', 'd', 1, '2026-11-01');
  `);
  const result = await db.prepare("UPDATE orders SET shipping_status = 'processing'").run();
  assert.equal(result.meta.changes, 4, "two rows, each bumped again by the 0075 trigger");
  await assert.rejects(
    db.batch([db.prepare("UPDATE stores SET name = 'changed' WHERE id = 1"), db.prepare("INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'x', 'x', 'x')")]),
    /UNIQUE constraint failed/,
  );
  assert.equal(await db.prepare("SELECT name FROM stores WHERE id = 1").first("name"), "T");
  assert.deepEqual(await db.prepare("SELECT ? AS t, ? AS f").bind(true, false).first(), { t: 1, f: 0 });
  assert.throws(() => db.prepare("SELECT ?").bind(undefined), /D1_TYPE_ERROR/);
  await assert.rejects(db.prepare("SELECT 7 AS n").first("missing"), /D1_COLUMN_NOTFOUND/);
  assert.deepEqual(await db.prepare("SELECT 1 AS a, 'x' AS b").raw({ columnNames: true }), [["a", "b"], [1, "x"]]);
  await assert.rejects(db.exec("SELECT 1"), /TENANT_DB_UNSUPPORTED/);
  const other = createTenantDb(objectFor(createNodeStorage()).stub);
  await assert.rejects(db.batch([other.prepare("SELECT 1")]), /TENANT_DB_FOREIGN_STATEMENT/);
});

test("real checkout, lead and lifecycle code runs unchanged through the adapter", async () => {
  const store = objectFor(storeAt(CHAIN.length));
  const db = createTenantDb(store.stub);
  store.storage.db.exec(`
    INSERT INTO stores (id, name, slug, created_at) VALUES (1, 'Toko', 'toko', '2026-11-01');
    INSERT INTO products (id, store_id, title, slug, created_at) VALUES (11111, 1, 'Pupuk', 'pupuk', '2026-11-01');
    INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (101, 11111, 'P-1', '1 kg', 50000), (102, 11111, 'P-2', '2 kg', 90000);
  `);
  const lead = await recordAbandonedOrder(db, { customerName: "Siti Rahayu", customerPhone: "081234567890", variantId: 102 });
  const order = await persistOrder(db, {
    submitToken: "sb_tenant_store_conformance",
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
  assert.deepEqual(await updateAdminOrderShippingStatuses(db, [order.id], "cancelled"), { updatedIds: [order.id], conflictIds: [] });
  assert.deepEqual((await deleteOrdersReleasingReservations(db, [order.id])).map((row) => row.id), [order.id]);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM orders").first("n"), 0);
});
