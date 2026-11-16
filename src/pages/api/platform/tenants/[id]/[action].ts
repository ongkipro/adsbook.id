import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { ACTION_ROLES, runTenantAction, type TenantAction } from "../../../../../platform/admin/tenants.ts";

export const prerender = false;

/** API-6: suspend | resume | plan | purge-request | recover, by role (AUTHZ-3), each audited (IAM-6). */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const action = String(params.action ?? "") as TenantAction;
  if (!(action in ACTION_ROLES)) return Response.json({ success: false, error: "Aksi tidak dikenal." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await runTenantAction(platformDb, user, String(params.id ?? ""), action, body);
  if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status });
  return Response.json({
    success: true,
    message: result.message,
    // Shown once to the operator, who hands it to the owner out of band (IAM-9).
    data: result.recoveryToken ? { recovery_token: result.recoveryToken } : {},
  }, { headers: { "cache-control": "private, no-store" } });
};
