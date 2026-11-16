import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { getClientIp } from "../../../lib/rate-limit.ts";
import { PLATFORM_COOKIE_NAME, PLATFORM_COOKIE_OPTIONS, PLATFORM_SESSION_MS, platformLogin } from "../../../platform/admin/session.ts";

export const prerender = false;

/** IAM-3 sign-in: password and TOTP, one generic error, rate limited per address. */
export const POST: APIRoute = async ({ request, locals, cookies }) => {
  // IAM-5 strict same-origin is enforced by the platform guard before this runs.
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const result = await platformLogin(env, { email: body?.email, password: body?.password, totp: body?.totp }, getClientIp(request.headers));
  if (!result.ok) {
    const error = result.status === 429 ? "Terlalu banyak percobaan. Coba lagi nanti." : result.status === 503 ? "Login platform belum tersedia." : "Email, password, atau kode salah.";
    return Response.json({ success: false, error }, { status: result.status });
  }
  cookies.set(PLATFORM_COOKIE_NAME, result.cookie, { ...PLATFORM_COOKIE_OPTIONS, maxAge: PLATFORM_SESSION_MS / 1000 });
  return Response.json({ success: true, data: { email: result.user.email, role: result.user.role } });
};
