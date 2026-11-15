/**
 * The SQL engine of a tenant store, free of any runtime import so the same
 * code runs inside a SQLite-backed Durable Object (workerd) and under
 * `node --test` against `node:sqlite`.
 *
 * Result shapes follow D1 (`MULTI-TENANT-DESIGN.md` §4.2): `meta.changes` is
 * the `total_changes()` delta of the statement, which counts trigger writes
 * as D1 does; `rows_read`/`rows_written` come from the cursor.
 */

/** Bumped whenever a Worker↔store RPC signature or result shape changes (§4.1 item 8). */
export const TENANT_STORE_PROTOCOL = 1;

export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

export type StatementDescriptor = { sql: string; args: SqlValue[] };

export type StoreMeta = {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
};

export type StatementResult = {
  results: Row[];
  /** Present only for raw reads: the rows as value arrays, in `columns` order. */
  raw?: SqlValue[][];
  columns: string[];
  meta: StoreMeta;
};

export interface CursorLike {
  toArray(): Row[];
  raw(): IterableIterator<SqlValue[]>;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface SqlLike {
  exec(query: string, ...bindings: SqlValue[]): CursorLike;
  readonly databaseSize: number;
}

export interface StorageLike {
  readonly sql: SqlLike;
  transactionSync<T>(closure: () => T): T;
}

function scalar(sql: SqlLike, query: string): number {
  const row = sql.exec(query).toArray()[0];
  return Number(row ? Object.values(row)[0] : 0);
}

/**
 * Runs one statement and builds its D1-shaped result. Synchronous on purpose:
 * the cursor is consumed before anything can interleave (§4.1 item 3).
 */
export function executeStatement(
  storage: StorageLike,
  statement: StatementDescriptor,
  raw = false,
): StatementResult {
  const sql = storage.sql;
  const before = scalar(sql, "SELECT total_changes()");
  const cursor = sql.exec(statement.sql, ...statement.args);
  const rawRows = raw ? [...cursor.raw()] : undefined;
  const results = raw ? [] : cursor.toArray();
  const changes = scalar(sql, "SELECT total_changes()") - before;
  return {
    results,
    raw: rawRows,
    columns: [...cursor.columnNames],
    meta: {
      duration: 0,
      size_after: sql.databaseSize,
      rows_read: cursor.rowsRead,
      rows_written: cursor.rowsWritten,
      last_row_id: scalar(sql, "SELECT last_insert_rowid()"),
      changed_db: changes > 0,
      changes,
    },
  };
}

/** All statements in one transaction: every one applies or none does (D1 batch semantics). */
export function executeBatch(
  storage: StorageLike,
  statements: readonly StatementDescriptor[],
): StatementResult[] {
  return storage.transactionSync(() =>
    statements.map((statement) => executeStatement(storage, statement)),
  );
}

// ── Migrations (§4.4) ───────────────────────────────────────────────────────

export const MIGRATIONS_TABLE = "d1_migrations";

export type MigrationFile = { name: string; sql: string };

/** The ledger as the object sees it. Reading never creates or changes anything. */
export function readLedger(storage: StorageLike): string[] {
  const exists = storage.sql
    .exec("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS_TABLE)
    .toArray().length > 0;
  if (!exists) return [];
  return storage.sql
    .exec(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`)
    .toArray()
    .map((row) => String(row.name));
}

/**
 * Applies one migration file in its own transaction: the ledger row and every
 * statement commit together or not at all. `split` is the repository's
 * `splitMigrationStatements`, which keeps trigger bodies whole.
 */
export function applyMigrationFile(
  storage: StorageLike,
  migration: MigrationFile,
  split: (sql: string) => string[],
): void {
  const statements = split(migration.sql);
  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    storage.sql.exec(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`, migration.name);
    for (const statement of statements) storage.sql.exec(statement).toArray();
  });
}

/** The applied prefix must equal the bundled chain's prefix, file for file. */
export function assertKnownPrefix(applied: readonly string[], chain: readonly MigrationFile[]): void {
  if (applied.length > chain.length) {
    throw new Error(`TENANT_SCHEMA_AHEAD: store has ${applied.length}, release bundles ${chain.length}`);
  }
  applied.forEach((name, index) => {
    if (chain[index]?.name !== name) {
      throw new Error(`TENANT_SCHEMA_HISTORY_UNKNOWN: ${name} at ${index}`);
    }
  });
}
