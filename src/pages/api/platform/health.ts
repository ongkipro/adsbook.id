import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { platformHealth } from "../../../platform/admin/health.ts";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  if (!platformDb || !locals.platformUser) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  return Response.json({ success: true, data: await platformHealth(platformDb) });
};
