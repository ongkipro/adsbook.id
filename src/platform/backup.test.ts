import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { splitMigrationStatements } from "../lib/schema-version.ts";
import { BACKUP_PAGE_ROWS, EPHEMERAL_TABLES, exportPlatformDbSql, runDailyPlatformBackup, type BackupBucket } from "./backup.ts";
import { HostCache, resolveTenantHost } from "./control-plane.ts";

/** A D1-shaped handle over node:sqlite (the calls backup.ts and the gate make). */
function asD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => { bound.push(...values); return statement; },
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(bound as never[])).changes) } }),
        first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...(bound as never[])) }),
      };
      return statement;
    },
  } as unknown as D1Database;
}

const MIGRATIONS = new URL("./migrations/", import.meta.url);
const MIGRATION_FILES = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();

/** The production control plane: the chain applied and recorded in the ledger wrangler keeps. */
function controlPlane() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const name of MIGRATION_FILES) {
    for (const statement of splitMigrationStatements(readFileSync(new URL(name, MIGRATIONS), "utf8"))) sqlite.exec(statement);
    sqlite.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-11-16 08:54:29')").run(name);
  }
  return sqlite;
}

const TRICKY = "Toko O'Brien \"kutip\"\nbaris dua; DROP TABLE tenants; -- bukan komentar\t☕ 🌶️ é";

function seed(sqlite: DatabaseSync) {
  const run = (sql: string, ...values: unknown[]) => sqlite.prepare(sql).run(...(values as never[]));
  run("INSERT INTO tenants (id, slug, owner_email, status, created_at, owner_whatsapp, subscription_ends_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
    "t_a", "toko-a", "a@example.test", "2026-11-16T11:11:06.799Z", "6281234567890", "2026-12-17T11:07:59.559Z");
  run("INSERT INTO tenants (id, slug, owner_email, status, created_at, purge_after) VALUES (?, ?, ?, 'active', ?, NULL)",
    "t_b", "toko-b", TRICKY, "2026-11-16T18:30:23.710Z");
  run("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, ?)",
    "toko-a.adsbook.my.id", "t_a", "2026-11-16T11:11:06.799Z");
  run("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at, cf_custom_hostname_id) VALUES (?, ?, 'custom', 'pending', 0, ?, ?)",
    "www.toko-b.test", "t_b", "2026-11-17T00:00:00.000Z", "023e105f4ecef8ad9ca31a8372d0c353");
  run(`INSERT INTO subscription_invoices (id, invoice_number, tenant_id, cycle_code, days, amount_idr, admin_fee_idr, total_idr,
         channel_code, provider_trx_id, qr_payload, status, expires_at, created_at)
       VALUES ('inv_1', 'ADB-20261116-X', 't_a', '1m', 30, 149000, 1043, 150043, 'QRIS', 'trx-1', ?, 'expired', '2026-11-17T17:47:44.998Z', '2026-11-16T17:47:44.998Z')`,
    "00020101021226\n'qr'\n");
  run("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at, totp_last_step) VALUES ('pu_1', 'owner@example.test', 'pbkdf2$1$x', 'JBSWY3DPEHPK3PXP', 'platform_owner', '2026-11-16T10:34:04.014Z', 59063337)");
  run("INSERT INTO webhook_secrets (tenant_id, provider, secret_hash, created_at) VALUES ('t_a', 'autolaris', 'sha256:abc', '2026-11-16T11:11:07.000Z')");
  run("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES ('t_a', 'signup', 'a@example.test', '2026-11-16T11:11:07.996Z', ?)", JSON.stringify({ reason: TRICKY }));
  run("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES ('t_b', 'signup', 'platform', '2026-11-16T18:30:24.952Z', NULL)");
  run("INSERT INTO tenant_health (tenant_id, heartbeat_at, outbox_backlog, last_error, snapshot_json) VALUES ('t_a', '2026-11-18T04:16:15.971Z', 0, NULL, NULL)");
  run("INSERT INTO tenant_usage_daily (tenant_id, day, orders, requests, media_bytes) VALUES ('t_a', '2026-11-17', 3, 9007199254740991, 1048576)");
  run("INSERT INTO migration_bookmarks (tenant_id, schema_version, bookmark, at) VALUES ('t_a', 82, 'bm-1', '2026-11-16T11:11:07.000Z')");
  run("INSERT INTO operator_notices (tenant_id, notice, sent_at) VALUES ('t_a', 'signup', '2026-11-16T11:11:08.000Z')");
  run("INSERT INTO shared_mengantar_areas (area_key, area_id, label, postal_code, payload, resolved_at) VALUES ('coblong|bandung', 'A-1', ?, '40135', ?, '2026-11-17T19:40:00.000Z')",
    "Coblong, Kota Bandung — Jawa Barat", JSON.stringify({ label: "Dago 'atas'\nBandung" }));
  // Ephemeral: never in a backup.
  run("INSERT INTO platform_sessions (id, user_id, expires_at, created_at) VALUES ('sess-hash', 'pu_1', '2026-11-19T00:00:00.000Z', '2026-11-18T00:00:00.000Z')");
  run("INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at) VALUES ('handoff-hash', 't_a', 'signup', 'toko-a.adsbook.my.id', '2026-11-16T11:16:00.000Z')");
  run("INSERT INTO rate_limits (key, count, reset_at) VALUES ('signup:203.0.113.9', 2, 1763290000000)");
}

function memoryBucket() {
  const objects = new Map<string, { body: string; customMetadata?: Record<string, string>; contentType?: string }>();
  let puts = 0;
  const bucket = {
    head: async (key: string) => (objects.has(key) ? { key } : null),
    put: async (key: string, body: Uint8Array, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }) => {
      puts += 1;
      objects.set(key, { body: new TextDecoder().decode(body), customMetadata: options?.customMetadata, contentType: options?.httpMetadata?.contentType });
      return { key };
    },
  } as unknown as BackupBucket;
  return { bucket, objects, puts: () => puts };
}

const schemaOf = (sqlite: DatabaseSync) =>
  sqlite
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name")
    .all()
    .map((row) => ({ ...row, sql: String((row as { sql: string | null }).sql ?? "").replace(/\s+/g, " ").trim() }));

const tablesOf = (sqlite: DatabaseSync) =>
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()
    .map((row) => String((row as { name: string }).name));

/** Every value with its storage class (1 and 1.0, '1' and 1 differ) and a text's bytes (quote() stops at a NUL). */
const rowsOf = (sqlite: DatabaseSync, table: string) => {
  const columns = sqlite.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).all(table).map((row) => String((row as { name: string }).name));
  const select = columns
    .map((name) => `"${name.replaceAll('"', '""')}"`)
    .map((column) => `typeof(${column}), quote(${column}), CASE WHEN typeof(${column}) = 'text' THEN hex(${column}) END`)
    .join(", ");
  return sqlite.prepare(`SELECT ${select} FROM "${table}" ORDER BY rowid`).all();
};

test("the cron writes one file per UTC day from 01:00, keyed like the T-30 drill, with its counts", async () => {
  const sqlite = controlPlane();
  seed(sqlite);
  const db = asD1(sqlite);
  const r2 = memoryBucket();

  assert.deepEqual(await runDailyPlatformBackup(undefined, db, new Date("2026-11-18T01:07:00Z")), { status: "skipped", reason: "no-bucket" });
  assert.deepEqual(await runDailyPlatformBackup(r2.bucket, db, new Date("2026-11-18T00:07:00Z")), { status: "skipped", reason: "before-hour" });
  assert.equal(r2.puts(), 0);

  const first = await runDailyPlatformBackup(r2.bucket, db, new Date("2026-11-18T01:07:00Z"));
  assert.equal(first.status, "written");
  assert.equal(first.status === "written" && first.key, "platform-db/2026-11-18.sql");
  const stored = r2.objects.get("platform-db/2026-11-18.sql");
  assert.ok(stored);
  assert.equal(stored.contentType, "application/sql; charset=utf-8");
  assert.equal(stored.customMetadata?.exportedAt, "2026-11-18T01:07:00.000Z");
  assert.equal(stored.customMetadata?.bytes, String(new TextEncoder().encode(stored.body).byteLength));
  assert.equal(stored.customMetadata?.tables, String(tablesOf(sqlite).length));
  assert.equal(Number(stored.customMetadata?.rows) > 0, true);

  // Every later run that day: one head, no export, no overwrite.
  sqlite.prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at) VALUES ('t_a', 'later', 'platform', '2026-11-18T02:00:00Z')").run();
  assert.deepEqual(await runDailyPlatformBackup(r2.bucket, db, new Date("2026-11-18T02:07:00Z")), { status: "exists", key: "platform-db/2026-11-18.sql" });
  assert.deepEqual(await runDailyPlatformBackup(r2.bucket, db, new Date("2026-11-18T23:07:00Z")), { status: "exists", key: "platform-db/2026-11-18.sql" });
  assert.equal(r2.puts(), 1);
  assert.equal(r2.objects.get("platform-db/2026-11-18.sql")?.body, stored.body, "the day's file is never rewritten");

  // A missed 01:07 is made good at the next hour; the next day gets its own key.
  assert.deepEqual(await runDailyPlatformBackup(r2.bucket, db, new Date("2026-11-19T00:07:00Z")), { status: "skipped", reason: "before-hour" });
  const next = await runDailyPlatformBackup(r2.bucket, db, new Date("2026-11-19T03:07:00Z"));
  assert.equal(next.status === "written" && next.key, "platform-db/2026-11-19.sql");
  assert.equal(r2.puts(), 2);
  assert.match(r2.objects.get("platform-db/2026-11-19.sql")?.body ?? "", /'later'/);
});

test("the file replays on an empty database with foreign keys on: same schema, same rows, the gate resolves, no live session", async () => {
  const source = controlPlane();
  seed(source);
  const { sql, rows } = await exportPlatformDbSql(asD1(source));

  assert.doesNotMatch(sql, /sess-hash|handoff-hash|203\.0\.113\.9/, "no session, handoff token or rate window is written");
  // A trigger body's BEGIN … END is not a transaction statement.
  assert.doesNotMatch(sql, /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;|COMMIT\b|END\s+TRANSACTION\b|ROLLBACK\b)/im, "D1 refuses transaction statements in a file");
  assert.match(sql, /^PRAGMA defer_foreign_keys = ON;$/m);

  const restored = new DatabaseSync(":memory:");
  restored.exec("PRAGMA foreign_keys = ON");
  restored.exec(sql);

  assert.deepEqual(schemaOf(restored), schemaOf(source), "every table, index and trigger");
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  let copied = 0;
  for (const table of tablesOf(source)) {
    if (EPHEMERAL_TABLES.has(table)) {
      assert.equal((restored.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n, 0, `${table} keeps its schema, not its rows`);
      continue;
    }
    const expected = rowsOf(source, table);
    assert.deepEqual(rowsOf(restored, table), expected, table);
    copied += expected.length;
  }
  assert.equal(rows, copied);
  assert.equal(
    (restored.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tenant_events'").get() as { seq: number }).seq,
    (source.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tenant_events'").get() as { seq: number }).seq,
    "AUTOINCREMENT continues after the restored ids",
  );

  // The gate's own read answers from the restored control plane.
  const resolution = await resolveTenantHost(asD1(restored), "toko-a.adsbook.my.id", new Date("2026-11-18T05:00:00Z"), new HostCache());
  assert.equal(resolution.kind, "tenant");
  assert.equal(resolution.kind === "tenant" && resolution.tenant.tenantId, "t_a");
  // The append-only guard came back with the schema.
  assert.throws(() => restored.exec("DELETE FROM tenant_events"));
});

test("values and shapes beyond today's schema replay exactly: reals, 64-bit integers, blobs, NUL, paging, a child named before its parent", async () => {
  const source = new DatabaseSync(":memory:");
  source.exec("PRAGMA foreign_keys = ON");
  source.exec(`
    CREATE TABLE z_parent (id TEXT PRIMARY KEY, "we""ird col" TEXT);
    CREATE TABLE a_child (id INTEGER PRIMARY KEY, parent TEXT NOT NULL REFERENCES z_parent (id), ratio REAL, big INTEGER, data BLOB, note TEXT, loose);
    CREATE TABLE keyed (k1 TEXT NOT NULL, k2 INTEGER NOT NULL, v TEXT, PRIMARY KEY (k1, k2)) WITHOUT ROWID;
    CREATE VIEW child_view AS SELECT id, note FROM a_child;
  `);
  source.prepare(`INSERT INTO z_parent (id, "we""ird col") VALUES ('p', 'q')`).run();
  const insert = source.prepare("INSERT INTO a_child (id, parent, ratio, big, data, note, loose) VALUES (?, 'p', ?, ?, ?, ?, ?)");
  insert.run(1, 0.1 + 0.2, 9223372036854775807n, new Uint8Array([0, 1, 254, 255]), "nul\u0000inside", 1.0);
  insert.run(2, -1e-300, -9223372036854775808n, new Uint8Array([]), "", "42");
  insert.run(3, 1.0, 0, null, null, null);
  const rows = BACKUP_PAGE_ROWS * 2 + 7;
  const many = source.prepare("INSERT INTO keyed (k1, k2, v) VALUES (?, ?, ?)");
  for (let i = 0; i < rows; i += 1) many.run(`k${i % 3}`, i, `v'${i}`);

  const { sql } = await exportPlatformDbSql(asD1(source));
  assert.ok(sql.indexOf('CREATE TABLE z_parent') < sql.indexOf('CREATE TABLE a_child'), "parent created first");
  assert.ok(sql.indexOf('INSERT INTO "z_parent"') < sql.indexOf('INSERT INTO "a_child"'), "parent rows first");

  const restored = new DatabaseSync(":memory:");
  restored.exec("PRAGMA foreign_keys = ON");
  restored.exec(sql);
  assert.deepEqual(schemaOf(restored), schemaOf(source));
  for (const table of ["z_parent", "a_child"]) assert.deepEqual(rowsOf(restored, table), rowsOf(source, table), table);
  const keyed = (db: DatabaseSync) => db.prepare("SELECT k1, k2, v FROM keyed ORDER BY k1, k2").all();
  assert.equal(keyed(restored).length, rows, "every page of a WITHOUT ROWID table");
  assert.deepEqual(keyed(restored), keyed(source));
  const bytes = "SELECT hex(note) AS h, typeof(note) AS t FROM a_child WHERE id = 1";
  assert.deepEqual(restored.prepare(bytes).get(), source.prepare(bytes).get());
  assert.equal((restored.prepare(bytes).get() as { h: string }).h, Buffer.from("nul\u0000inside").toString("hex").toUpperCase(), "the text after the NUL survives");
});
