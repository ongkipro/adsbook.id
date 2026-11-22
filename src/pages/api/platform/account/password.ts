import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { changeOwnPassword } from "../../../../platform/admin/credentials.ts";
import { PLATFORM_COOKIE_NAME, PLATFORM_COOKIE_OPTIONS } from "../../../../platform/admin/session.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store" };

/**
 * IAM-11 self change: `{ current, totp, password }`. On success every session
 * of this operator is revoked, this one included, and the cookie is cleared:
 * they sign in again with the new password.
 */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const user = locals.platformUser;
  if (!platformDb || !user) return Response.json({ success: false, error: "Unauthorized" }, { status: 401, headers: noStore });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await changeOwnPassword(platformDb, user, { current: body.current, totp: body.totp, password: body.password });
  if (!result.ok) return Response.json({ success: false, error: result.error }, { status: result.status, headers: noStore });
  cookies.delete(PLATFORM_COOKIE_NAME, PLATFORM_COOKIE_OPTIONS);
  return Response.json({ success: true, message: result.message }, { headers: noStore });
};
