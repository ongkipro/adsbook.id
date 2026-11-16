/**
 * A `StorageLike` over `node:sqlite`, so the tenant-store engine and adapter run
 * under `node --test`. It mirrors the two Durable Object behaviours the engine
 * relies on: `exec` returns a cursor, and `transactionSync` rolls back on throw.
 * Cursor row counters are not emulated (0); workerd reports the real ones.
 */
import { DatabaseSync } from "node:sqlite";

import type { CursorLike, Row, SqlLike, SqlValue, StorageLike } from "../store-core.ts";

class NodeSql implements SqlLike {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  exec(query: string, ...bindings: SqlValue[]): CursorLike {
    if (/^\s*(BEGIN|COMMIT|SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(query)) {
      // A Durable Object refuses transaction control in SQL (§4.1 item 2).
      throw new Error(`not authorized: use transactionSync instead of ${query.trim().split(/\s+/)[0]}`);
    }
    const statement = this.#db.prepare(query);
    const columnNames = statement.columns().map((column) => column.name);
    const rows = (statement.all(...(bindings as never[])) as Row[]).map((row) => ({ ...row }));
    return {
      toArray: () => rows,
      raw: () => rows.map((row) => columnNames.map((name) => row[name] ?? null))[Symbol.iterator](),
      columnNames,
      rowsRead: 0,
      rowsWritten: 0,
    };
  }

  get databaseSize(): number {
    const pages = this.#db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.#db.prepare("PRAGMA page_size").get() as { page_size: number };
    return pages.page_count * size.page_size;
  }
}

export function createNodeStorage(db = new DatabaseSync(":memory:")): StorageLike & { db: DatabaseSync } {
  db.exec("PRAGMA foreign_keys = ON");
  const sql = new NodeSql(db);
  let depth = 0;
  return {
    db,
    sql,
    transactionSync<T>(closure: () => T): T {
      const name = `tx${depth}`;
      depth += 1;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = closure();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
}
