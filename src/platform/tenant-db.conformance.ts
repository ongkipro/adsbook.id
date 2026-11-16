// T-18 (SPIKE-1 item 5): compiles only if the adapter satisfies the installed D1 types in
// every call shape the code base uses. Never executed.
import { createTenantDb, type TenantStoreRpc } from "./tenant-db.ts";

declare const rpc: TenantStoreRpc;

export async function conformance(): Promise<void> {
  const db: D1Database = createTenantDb(rpc);
  const statement: D1PreparedStatement = db.prepare("SELECT ?1 AS id").bind(1);
  const row: { id: number } | null = await statement.first<{ id: number }>();
  const column: number | null = await statement.first<number>("id");
  const all: D1Result<{ id: number }> = await statement.all<{ id: number }>();
  const run: D1Result = await db.prepare("DELETE FROM t").run();
  const changes: number = run.meta.changes + all.meta.rows_read + (all.meta.last_row_id ?? 0);
  const raw: unknown[][] = await statement.raw();
  const [columns, ...rows]: [string[], ...[number][]] = await statement.raw<[number]>({ columnNames: true });
  const batch: D1Result<{ id: number }>[] = await db.batch<{ id: number }>([statement, db.prepare("SELECT 2")]);
  const session = db.withSession("first-primary");
  const bookmark: string | null = session.getBookmark();
  await session.prepare("SELECT 1").first();
  // A function typed on D1PreparedStatement (order-lifecycle.ts) accepts the adapter's.
  const takes = (mutation: D1PreparedStatement) => mutation;
  takes(statement);
  void [row, column, changes, raw, columns, rows, batch, bookmark];
}
