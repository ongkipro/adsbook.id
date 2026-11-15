import { getRuntimeEnv } from "./env.ts";

/**
 * The tenant's database for this request (TEN-2): `locals.tenantDb`, which the
 * middleware opens from the gate's tenant id (`src/platform/tenant-db.ts`). A
 * library takes it from here or as a parameter, never from a binding.
 *
 * lazy: the `OMS_DB` fallback keeps call sites and tests that still hand
 * `runtimeEnv.OMS_DB` working while T-35/T-36/T-46 move them; T-46 removes it
 * together with the binding and adds the static ban.
 */
export function tenantDatabase(
  locals: { tenantDb?: D1Database; runtimeEnv?: unknown } | null | undefined,
): D1Database | undefined {
  if (locals?.tenantDb) return locals.tenantDb;
  const legacy = getRuntimeEnv(locals as App.Locals | undefined)?.OMS_DB as D1Database | undefined;
  return legacy && typeof legacy.prepare === "function" ? legacy : undefined;
}
