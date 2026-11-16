import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { tenantDetail } from "../../../../../platform/admin/tenants.ts";

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  if (!platformDb || !locals.platformUser) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const detail = await tenantDetail(platformDb, String(params.id ?? ""));
  return detail ? Response.json({ success: true, data: detail }) : Response.json({ success: false, error: "Tenant tidak ditemukan." }, { status: 404 });
};
