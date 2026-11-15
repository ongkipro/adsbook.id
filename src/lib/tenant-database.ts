/**
 * The tenant's database for this request (TEN-2): `locals.tenantDb`, which the
 * middleware opens from the gate's tenant id (`src/platform/tenant-db.ts`), or
 * the cron sets for the tenant it is running. A library takes it from here or
 * as a parameter; nothing outside `src/platform/` reaches a store binding
 * (`src/platform/static-bans.test.ts`).
 */
export function tenantDatabase(
  locals: { tenantDb?: D1Database } | null | undefined,
): D1Database | undefined {
  const database = locals?.tenantDb;
  return database && typeof database.prepare === "function" ? database : undefined;
}
