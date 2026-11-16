import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { PLATFORM_COOKIE_NAME, PLATFORM_COOKIE_OPTIONS, platformLogout } from "../../../platform/admin/session.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  await platformLogout((getRuntimeEnv(locals) ?? {}) as Record<string, unknown>, request);
  cookies.delete(PLATFORM_COOKIE_NAME, PLATFORM_COOKIE_OPTIONS);
  return Response.json({ success: true });
};
