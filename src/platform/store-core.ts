/**
 * The SQL engine of a tenant store (TD-3), free of any runtime import so the
 * same code runs inside the `TenantStore` Durable Object (workerd) and under
 * `node --test` against `node:sqlite`. Measured in SPIKE-1
 * (`MULTI-TENANT-DESIGN.md` §11).
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

// ── The migration protocol (§4.4, MIG-1) ─────────────────────────────────────

/** The object's own small key-value state: the recovery guard and restore undo. */
export interface StoreKv {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

export type SchemaState = {
  /** Files applied, per the object's ledger. */
  applied: number;
  /** Files in the chain bundled with this object's code. */
  bundled: number;
  /** The applied ledger is not a prefix of the bundled chain, nor the reverse. */
  historyUnknown: boolean;
  /** The object's own copy of the recovery guard; PLATFORM_DB is authoritative. */
  recovery: boolean;
  protocol: number;
};

/**
 * Everything the `TenantStore` object does, minus the runtime: the Durable
 * Object class only wires `ctx.storage` into this. The constructor reads the
 * ledger and nothing else — it never migrates (MIG-1).
 */
export class TenantStoreEngine {
  readonly #storage: StorageLike;
  readonly #kv: StoreKv;
  readonly #chain: readonly MigrationFile[];
  readonly #split: (sql: string) => string[];
  #applied: string[];

  constructor(storage: StorageLike, kv: StoreKv, chain: readonly MigrationFile[], split: (sql: string) => string[]) {
    this.#storage = storage;
    this.#kv = kv;
    this.#chain = chain;
    this.#split = split;
    this.#applied = readLedger(storage);
  }

  checkProtocol(protocol: number): void {
    if (protocol !== TENANT_STORE_PROTOCOL) {
      throw new Error(`TENANT_STORE_PROTOCOL_MISMATCH: worker ${protocol}, store ${TENANT_STORE_PROTOCOL}`);
    }
  }

  query(statement: StatementDescriptor, raw: boolean): StatementResult {
    return executeStatement(this.#storage, statement, raw);
  }

  batch(statements: readonly StatementDescriptor[]): StatementResult[] {
    return executeBatch(this.#storage, statements);
  }

  schemaState(): SchemaState {
    const shared = Math.min(this.#applied.length, this.#chain.length);
    const historyUnknown = this.#applied.slice(0, shared).some((name, index) => this.#chain[index]?.name !== name);
    return {
      applied: this.#applied.length,
      bundled: this.#chain.length,
      historyUnknown,
      recovery: this.#kv.get("recovery") === true,
      protocol: TENANT_STORE_PROTOCOL,
    };
  }

  /**
   * Step 3 of §4.4. The Worker passes the id of the bookmark row it stored
   * first; without one nothing runs. Each file is its own transaction; a file
   * that fails rolls back, sets the object's recovery guard and throws.
   */
  applyMigrations(target: number, bookmarkId: string): SchemaState {
    if (!bookmarkId) throw new Error("TENANT_MIGRATION_NO_BOOKMARK");
    if (this.#kv.get("recovery") === true) throw new Error("TENANT_IN_RECOVERY");
    assertKnownPrefix(this.#applied, this.#chain);
    const goal = Math.min(target, this.#chain.length);
    while (this.#applied.length < goal) {
      const file = this.#chain[this.#applied.length];
      try {
        applyMigrationFile(this.#storage, file, this.#split);
      } catch (error) {
        this.#kv.put("recovery", true);
        throw new Error(`TENANT_MIGRATION_FAILED: ${file.name}: ${(error as Error).message}`);
      }
      this.#applied = [...this.#applied, file.name];
    }
    return this.schemaState();
  }

  /** Operator action (§4.5): automatic migration resumes only when this is cleared. */
  setRecovery(recovery: boolean): void {
    if (recovery) this.#kv.put("recovery", true);
    else this.#kv.delete("recovery");
  }

  rememberRestoreUndo(bookmark: string): void {
    this.#kv.put("restore_undo", bookmark);
    this.#kv.put("recovery", true);
  }
}
