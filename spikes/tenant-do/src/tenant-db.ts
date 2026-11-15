import {
  TENANT_STORE_PROTOCOL,
  type Row,
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
