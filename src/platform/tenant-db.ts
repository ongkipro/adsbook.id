/**
 * The tenant data capability (TD-4, TEN-2): a `D1Database` whose every
 * statement runs in one tenant's `TenantStore`, and the Worker's half of the
 * migration protocol (`MULTI-TENANT-DESIGN.md` §4.4, MIG-1/MIG-2).
 *
 * Call sites keep their D1 shape (SPIKE-1 item 5): `prepare`/`bind` build
 * descriptors locally; `first`/`all`/`run`/`raw` are one RPC each and `batch`
 * is one RPC run in a single store transaction.
 */
import {
  TENANT_STORE_PROTOCOL,
  type Row,
  type SchemaState,
  type SqlValue,
  type StatementDescriptor,
  type StatementResult,
} from "./store-core.ts";

/** What the adapter needs from a `TenantStore` stub: two RPC methods. */
export interface TenantStoreRpc {
  query(protocol: number, statement: StatementDescriptor, raw: boolean): Promise<StatementResult>;
  batch(protocol: number, statements: StatementDescriptor[]): Promise<StatementResult[]>;
}

export class TenantDbUnsupportedError extends Error {
  constructor(method: string) {
    super(`TENANT_DB_UNSUPPORTED: ${method} is not available on a tenant store`);
    this.name = "TenantDbUnsupportedError";
  }
}

/** D1's binding rules: booleans become integers; `undefined` and objects are refused. */
function toSqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new TypeError(`D1_TYPE_ERROR: Type '${value === undefined ? "undefined" : typeof value}' not supported for value '${String(value)}'`);
}

function d1Result<T>(result: StatementResult): D1Result<T> {
  return { success: true, results: result.results as T[], meta: { ...result.meta } };
}

class TenantPreparedStatement implements D1PreparedStatement {
  readonly #rpc: TenantStoreRpc;
  readonly descriptor: StatementDescriptor;

  constructor(rpc: TenantStoreRpc, sql: string, args: SqlValue[] = []) {
    this.#rpc = rpc;
    this.descriptor = Object.freeze({ sql, args });
  }

  belongsTo(rpc: TenantStoreRpc): boolean {
    return this.#rpc === rpc;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new TenantPreparedStatement(this.#rpc, this.descriptor.sql, values.map(toSqlValue));
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    const { results } = await this.#rpc.query(TENANT_STORE_PROTOCOL, this.descriptor, false);
    const row: Row | undefined = results[0];
    if (!row) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${colName})`);
    return row[colName] as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result<T>(await this.#rpc.query(TENANT_STORE_PROTOCOL, this.descriptor, false));
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result<T>(await this.#rpc.query(TENANT_STORE_PROTOCOL, this.descriptor, false));
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
    const result = await this.#rpc.query(TENANT_STORE_PROTOCOL, this.descriptor, true);
    const rows = (result.raw ?? []) as T[];
    return options?.columnNames ? [result.columns, ...rows] : rows;
  }
}

/**
 * A `D1Database` whose every statement runs in one tenant's `TenantStore`.
 * `prepare`/`bind` build descriptors locally; `first`/`all`/`run`/`raw` are one
 * RPC each and `batch` is one RPC run in a single store transaction.
 */
export function createTenantDb(rpc: TenantStoreRpc): D1Database {
  const prepare = (query: string): D1PreparedStatement => new TenantPreparedStatement(rpc, query);
  const batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const descriptors = statements.map((statement) => {
      if (!(statement instanceof TenantPreparedStatement) || !statement.belongsTo(rpc)) {
        throw new Error("TENANT_DB_FOREIGN_STATEMENT: a batch may only hold statements prepared on the same tenant store");
      }
      return statement.descriptor;
    });
    if (descriptors.length === 0) return [];
    return (await rpc.batch(TENANT_STORE_PROTOCOL, descriptors)).map((result) => d1Result<T>(result));
  };
  return {
    prepare,
    batch,
    exec: async () => {
      throw new TenantDbUnsupportedError("exec");
    },
    dump: async () => {
      throw new TenantDbUnsupportedError("dump");
    },
    // One primary per store: a session is the store itself, and its bookmark is constant.
    withSession: () => ({ prepare, batch, getBookmark: () => null }),
  };
}

// ── The Worker's half of the migration protocol ─────────────────────────────

/** The `TenantStore` stub, as this module uses it. */
export interface TenantStoreStub extends TenantStoreRpc {
  schemaState(protocol: number): Promise<SchemaState>;
  prepareMigration(protocol: number): Promise<{ bookmark: string; state: SchemaState }>;
  applyMigrations(protocol: number, target: number, bookmarkId: string): Promise<SchemaState>;
}

/** The tenant cannot be served right now; the caller answers 503 for this tenant only. */
export class TenantUnavailableError extends Error {
  readonly reason: "recovery" | "bookmark" | "migration" | "history" | "protocol";

  constructor(reason: TenantUnavailableError["reason"], detail: string) {
    super(`TENANT_UNAVAILABLE (${reason}): ${detail}`);
    this.name = "TenantUnavailableError";
    this.reason = reason;
  }
}

/** Per isolate: a tenant checked at a target is not checked again by this isolate. */
const readyTenants = new Map<string, Promise<SchemaState>>();

export type EnsureSchemaOptions = {
  now?: () => Date;
  /** Bounded in tests; the module-level map in production. */
  ready?: Map<string, Promise<SchemaState>>;
};

/**
 * Brings one tenant's store to `target` files, at most once per isolate:
 *
 * 1. Ask the store its state. Ahead of `target` with a known history is served:
 *    releases only add (expand-and-contract with drain), so a rollback keeps
 *    every tenant up. An unknown history is a 503 for that tenant only.
 * 2. Behind: take the store's PITR bookmark and **store it in `PLATFORM_DB`
 *    first**. If that write fails, nothing migrates and the request is a 503.
 * 3. Apply. A failing file leaves the store in `recovery`; `PLATFORM_DB` is set
 *    to `recovery` too (it is the authoritative copy: a restore rolls the
 *    object's own storage back) and an audit row is written.
 */
export async function ensureTenantSchema(
  platformDb: D1Database,
  stub: TenantStoreStub,
  tenantId: string,
  target: number,
  options: EnsureSchemaOptions = {},
): Promise<SchemaState> {
  const ready = options.ready ?? readyTenants;
  const key = `${tenantId}\u0000${target}`;
  const existing = ready.get(key);
  if (existing) return existing;
  const attempt = migrateTenant(platformDb, stub, tenantId, target, options.now ?? (() => new Date())).catch((error) => {
    ready.delete(key);
    throw error;
  });
  ready.set(key, attempt);
  return attempt;
}

async function migrateTenant(
  platformDb: D1Database,
  stub: TenantStoreStub,
  tenantId: string,
  target: number,
  now: () => Date,
): Promise<SchemaState> {
  let state: SchemaState;
  try {
    state = await stub.schemaState(TENANT_STORE_PROTOCOL);
  } catch (error) {
    // Most often an object still on the previous release's protocol (§4.1 item 8).
    throw new TenantUnavailableError("protocol", (error as Error).message);
  }
  if (state.historyUnknown) throw new TenantUnavailableError("history", `${state.applied} files applied`);
  if (state.applied >= target) return state;
  if (state.recovery) throw new TenantUnavailableError("recovery", "migration paused");

  const prepared = await stub.prepareMigration(TENANT_STORE_PROTOCOL);
  const bookmarkId = `${tenantId}:${prepared.state.applied}`;
  try {
    // A concurrent request may have stored this version's bookmark first; both continue.
    await platformDb
      .prepare(
        `INSERT INTO migration_bookmarks (tenant_id, schema_version, bookmark, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, schema_version) DO NOTHING`,
      )
      .bind(tenantId, prepared.state.applied, prepared.bookmark, now().toISOString())
      .run();
  } catch (error) {
    throw new TenantUnavailableError("bookmark", (error as Error).message);
  }

  let migrated: SchemaState;
  try {
    migrated = await stub.applyMigrations(TENANT_STORE_PROTOCOL, target, bookmarkId);
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    if (/TENANT_IN_RECOVERY/.test(message)) throw new TenantUnavailableError("recovery", message);
    await platformDb.batch([
      platformDb.prepare("UPDATE tenants SET status = 'recovery' WHERE id = ? AND status = 'active'").bind(tenantId),
      platformDb
        .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, 'migration_failed', 'platform', ?, ?)")
        .bind(tenantId, now().toISOString(), JSON.stringify({ from: prepared.state.applied, target, bookmarkId, error: message })),
    ]);
    throw new TenantUnavailableError("migration", message);
  }
  await platformDb
    .prepare("UPDATE tenants SET schema_version = ? WHERE id = ? AND schema_version < ?")
    .bind(migrated.applied, tenantId, migrated.applied)
    .run();
  return migrated;
}

/** What `openTenantDb` reads from the runtime environment. Only `src/platform/` reads it. */
export type TenantDbEnv = {
  PLATFORM_DB?: unknown;
  TENANT_STORE?: unknown;
};

type StoreNamespace = {
  getByName(name: string, options?: { locationHint?: string }): unknown;
};

/**
 * The one way to a tenant's data (TEN-2): the gate's tenant id, a store
 * reached by that id with the APAC hint (DATA-1), its schema brought to
 * `target`, and the D1-shaped capability over it.
 */
export async function openTenantDb(
  env: TenantDbEnv | null | undefined,
  tenantId: string,
  target: number,
  options: EnsureSchemaOptions = {},
): Promise<D1Database> {
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const namespace = env?.TENANT_STORE as StoreNamespace | undefined;
  if (!platformDb?.prepare || typeof namespace?.getByName !== "function") {
    throw new TenantUnavailableError("protocol", "PLATFORM_DB or TENANT_STORE is not bound");
  }
  // The stub's RPC methods return the structured clone of the store's results.
  const stub = namespace.getByName(tenantId, { locationHint: "apac-se" }) as TenantStoreStub;
  await ensureTenantSchema(platformDb, stub, tenantId, target, options);
  return createTenantDb(stub);
}
