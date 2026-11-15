/**
 * Test helper: a `D1Database` over `node:sqlite` with D1's shapes — `first`,
 * `all`, `run` (with `RETURNING` rows), and `batch` as one transaction. Only
 * tests import it; it never reaches the Worker bundle.
 */
import { DatabaseSync } from "node:sqlite";

type Value = null | number | string;

export type SqliteD1 = D1Database & { sqlite: DatabaseSync; queries: string[]; failWhen: RegExp | null };

export function createSqliteD1(sqlite = new DatabaseSync(":memory:")): SqliteD1 {
  sqlite.exec("PRAGMA foreign_keys = ON");
  const queries: string[] = [];
  const state = { failWhen: null as RegExp | null };
  const check = (sql: string) => {
    queries.push(sql);
    if (state.failWhen?.test(sql)) throw new Error("D1_ERROR: injected failure");
  };
  const execute = (sql: string, values: Value[]) => {
    check(sql);
    const statement = sqlite.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const results = statement.all(...values).map((row) => ({ ...row }));
      return { success: true as const, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = statement.run(...values);
    return {
      success: true as const,
      results: [],
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  };
  const statement = (sql: string, values: Value[] = []) => ({
    sql,
    values,
    bind: (...next: unknown[]) => statement(sql, next.map((value) => (value === undefined ? null : (value as Value)))),
    first: async (column?: string) => {
      const row = execute(sql, values).results[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : row;
    },
    all: async () => execute(sql, values),
    run: async () => execute(sql, values),
    raw: async () => execute(sql, values).results.map((row) => Object.values(row)),
  });
  const db = {
    sqlite,
    queries,
    get failWhen() {
      return state.failWhen;
    },
    set failWhen(value: RegExp | null) {
      state.failWhen = value;
    },
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<ReturnType<typeof statement>>) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((item) => execute(item.sql, item.values));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    withSession() {
      return { prepare: db.prepare, batch: db.batch, getBookmark: () => null };
    },
    async exec() {
      throw new Error("exec is not used");
    },
    async dump() {
      throw new Error("dump is not used");
    },
  };
  return db as unknown as SqliteD1;
}
