import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { listTenants } from "../../../../platform/admin/tenants.ts";

export const prerender = false;

/** API-6: the tenant list (control-plane fields only, TEN-6). */
export const GET: APIRoute = async ({ locals, url }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  if (!platformDb || !locals.platformUser) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const tenants = await listTenants(platformDb, { status: url.searchParams.get("status"), search: url.searchParams.get("q"), billing: url.searchParams.get("billing") });
  return Response.json({ success: true, data: { tenants } });
};
