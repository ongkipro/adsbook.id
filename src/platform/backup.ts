/**
 * Daily `PLATFORM_DB` backup (T-30, MIG-3, PRIV-4): a restorable SQL snapshot
 * of the control plane, written by the platform cron to the private R2 bucket
 * `adsbook-platform-backup` (`BACKUP_BUCKET`) as `platform-db/YYYY-MM-DD.sql`
 * (UTC date; the key layout of the 2026-11-16 drill, PLATFORM-RUNBOOK §5).
 * The bucket's `expire-30-days` lifecycle rule removes old days; nothing here
 * deletes. Tenant data is not here: each tenant's `TenantStore` has its own
 * point-in-time recovery.
 *
 * What the file holds, in replay order:
 * 1. `PRAGMA defer_foreign_keys = ON` (what `wrangler d1 export` emits too);
 * 2. every table's `CREATE TABLE` from `sqlite_master`, parents before
 *    children by their foreign keys;
 * 3. the rows, in the same order, read in one D1 batch (one transaction,
 *    so one consistent snapshot), each value a SQLite `quote()` literal
 *    (exact for NULL, integers of any size, reals, text with quotes or
 *    newlines, and blobs; text holding a NUL goes as `CAST(X'…' AS TEXT)`);
 * 4. indexes, then triggers (the `tenant_events` append-only guards), so the
 *    inserts above fire nothing.
 * No `BEGIN`/`COMMIT`: D1 refuses them; `wrangler d1 execute --file` runs the
 * file as one unit. Restore: PLATFORM-RUNBOOK §9.
 *
 * Left out: `sqlite_*` internals (`sqlite_sequence` is rebuilt by the explicit
 * AUTOINCREMENT ids) and D1's own `_cf_*` tables. `EPHEMERAL_TABLES` keep their
 * schema but not their rows: live session and handoff token hashes and rate
 * windows help no recovery, and leaving them out keeps live sessions out of
 * every copy (SEC-6). Operator credential grants (IAM-11) are left out for the
 * same reason and one more: a copy taken before a link was used or revoked
 * would bring it back redeemable. Their issue/use audit rows stay in
 * `tenant_events`; after a restore, links reopen only behind a
 * `PLATFORM_CREDENTIAL_LINKS` instant (PLATFORM-RUNBOOK). Everything else — tenants, hosts, plans, invoices,
 * platform users (password hash and TOTP secret, needed to sign in after a
 * restore), webhook secrets, events, health, usage, notices, bookmarks, purge
 * sweeps, the shared Mengantar areas and the `d1_migrations` ledger — is kept
 * whole, which is why the bucket is private and operator-only.
 */

/** Tables whose rows are never written to a backup (their `CREATE TABLE` is). */
export const EPHEMERAL_TABLES: ReadonlySet<string> = new Set(["platform_sessions", "handoff_tokens", "rate_limits", "platform_credential_grants"]);

/** The UTC hour from which the cron writes the day's file (01:07 UTC, 08:07 WIB). */
export const BACKUP_FROM_UTC_HOUR = 1;

/** A backup still failing at this UTC hour (13:00 WIB) reaches the operator, once that day. */
export const BACKUP_ALERT_UTC_HOUR = 6;

export const backupKey = (now: Date) => `platform-db/${now.toISOString().slice(0, 10)}.sql`;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };

/** Parents before children; a cycle or a self-reference keeps the name order (defer covers it on D1). */
function foreignKeyOrder(tables: string[], parentsOf: Map<string, Set<string>>): string[] {
  const ordered: string[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (placed.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const parent of [...(parentsOf.get(name) ?? [])].sort()) if (parent !== name && tables.includes(parent)) visit(parent);
    visiting.delete(name);
    placed.add(name);
    ordered.push(name);
  };
  // The migration ledger first: a restore is recognisably a migrated control plane.
  for (const name of [...tables].sort((a, b) => Number(b === "d1_migrations") - Number(a === "d1_migrations") || a.localeCompare(b))) visit(name);
  return ordered;
}

/** One table's rows as `INSERT` text: the SELECT that reads them and how to print a row. */
async function tableReader(db: D1Database, table: string) {
  const columns = (
    await db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").bind(table).all<{ name: string }>()
  ).results.map((column) => ident(column.name));
  // quote() stops a text value at an embedded NUL; such a value goes as its UTF-8 bytes cast back to text.
  const literal = (name: string) =>
    `CASE WHEN typeof(${name}) = 'text' AND instr(CAST(${name} AS BLOB), x'00') > 0 THEN 'CAST(' || quote(CAST(${name} AS BLOB)) || ' AS TEXT)' ELSE quote(${name}) END`;
  const head = `INSERT INTO ${ident(table)} (${columns.join(", ")}) VALUES (`;
  return {
    select: db.prepare(`SELECT ${columns.map((column, index) => `${literal(column)} AS c${index}`).join(", ")} FROM ${ident(table)}`),
    toInsert: (row: Record<string, unknown>) => `${head}${columns.map((_, index) => String(row[`c${index}`])).join(", ")});`,
  };
}

export type PlatformDbSnapshot = { sql: string; tables: number; rows: number };

/** A statement's SQL text and its terminator; a text ending in a `--` comment gets its `;` on a line of its own. */
const statement = (sql: string) => {
  const text = sql.trim().replace(/;\s*$/, "");
  return /--[^\n]*$/.test(text) ? `${text}\n;` : `${text};`;
};

/**
 * The control plane as SQL that replays on an empty SQLite or D1 database.
 * Every table's rows are read in ONE `batch`, which D1 runs as one
 * transaction: a consistent snapshot, so a write during the export (a host
 * promoted to primary, a tenant and its first event) can never yield a file
 * that breaks a UNIQUE index or a foreign key on replay.
 * // lazy: the whole control plane is held in memory once as rows and once as
 * text — 233 kB on 2026-11-18. Past some tens of MB, page per table and
 * stream to an R2 multipart upload (and accept per-page consistency).
 */
export async function exportPlatformDbSql(db: D1Database): Promise<PlatformDbSnapshot> {
  const schema = (
    await db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view')
           AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'
           AND substr(tbl_name, 1, 7) <> 'sqlite_' AND substr(tbl_name, 1, 4) <> '_cf_'
         ORDER BY name`,
      )
      .all<SchemaRow>()
  ).results;
  const tableSql = new Map(schema.filter((row) => row.type === "table").map((row) => [row.name, row.sql as string]));
  const tables = [...tableSql.keys()];
  const parentsOf = new Map<string, Set<string>>();
  for (const table of tables) {
    const keys = (await db.prepare("SELECT \"table\" AS parent FROM pragma_foreign_key_list(?)").bind(table).all<{ parent: string }>()).results;
    parentsOf.set(table, new Set(keys.map((key) => key.parent)));
  }
  const order = foreignKeyOrder(tables, parentsOf);
  const kept = order.filter((table) => !EPHEMERAL_TABLES.has(table));
  const readers = await Promise.all(kept.map((table) => tableReader(db, table)));
  const results = readers.length ? await db.batch(readers.map((reader) => reader.select)) : [];
  const inserts = kept.flatMap((_, index) => ((results[index]?.results ?? []) as Record<string, unknown>[]).map(readers[index].toInsert));

  const lines = [
    "-- adsbook.id PLATFORM_DB backup (src/platform/backup.ts). Replay on an EMPTY database: PLATFORM-RUNBOOK §9.",
    `-- Rows of ${[...EPHEMERAL_TABLES].sort().join(", ")} are deliberately omitted (schema kept).`,
    "PRAGMA defer_foreign_keys = ON;",
    ...order.map((table) => statement(tableSql.get(table) as string)),
    ...inserts,
    ...schema.filter((row) => row.type === "index").map((row) => statement(row.sql as string)),
    ...schema.filter((row) => row.type === "view").map((row) => statement(row.sql as string)),
    ...schema.filter((row) => row.type === "trigger").map((row) => statement(row.sql as string)),
  ];
  return { sql: `${lines.join("\n")}\n`, tables: tables.length, rows: inserts.length };
}

/** The slice of R2 this job uses; the in-memory stand-in in the test implements the same. */
export type BackupBucket = Pick<R2Bucket, "head" | "put">;

export type BackupResult =
  | { status: "skipped"; reason: "no-bucket" | "before-hour" }
  | { status: "exists"; key: string }
  | { status: "written"; key: string; bytes: number; tables: number; rows: number };

/**
 * Writes the day's file once. Asked every hourly run from 01:07 UTC: one R2
 * `head` when the file already exists (no D1 read at all), and a run that
 * missed 01:07 is made good at the next hour.
 */
export async function runDailyPlatformBackup(
  bucket: BackupBucket | undefined,
  db: D1Database,
  now: Date,
): Promise<BackupResult> {
  if (!bucket) return { status: "skipped", reason: "no-bucket" };
  if (now.getUTCHours() < BACKUP_FROM_UTC_HOUR) return { status: "skipped", reason: "before-hour" };
  const key = backupKey(now);
  if (await bucket.head(key)) return { status: "exists", key };
  const snapshot = await exportPlatformDbSql(db);
  const body = new TextEncoder().encode(snapshot.sql);
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/sql; charset=utf-8" },
    customMetadata: {
      exportedAt: now.toISOString(),
      tables: String(snapshot.tables),
      rows: String(snapshot.rows),
      bytes: String(body.byteLength),
    },
  });
  return { status: "written", key, bytes: body.byteLength, tables: snapshot.tables, rows: snapshot.rows };
}
