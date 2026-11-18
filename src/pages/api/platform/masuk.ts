import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { getClientIp } from "../../../lib/rate-limit.ts";
import { storeLogin } from "../../../platform/login.ts";

export const prerender = false;

/**
 * adsbook.id/masuk's form post (AUTH-LOGIN-REGISTER-UX-SPEC §1.3): an email or
 * username and a password in, a two-minute `login` handoff for the store's
 * subdomain out. Same-origin only. The token is in this body alone and is
 * posted on to the store; no cookie is set here. (`/api/platform/login` is the
 * platform console's own sign-in and stays separate.)
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ success: false, error: "Forbidden request origin" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const result = await storeLogin(env, { identifier: body?.identifier, password: body?.password }, getClientIp(request.headers));
  if (result.status !== 200) {
    return Response.json({ success: false, error: result.error }, { status: result.status, headers: { "cache-control": "no-store" } });
  }
  // The store answers on the same scheme and port as this platform host (local dev keeps its port).
  const base = `${url.protocol}//${result.host}${url.port ? `:${url.port}` : ""}`;
  return Response.json(
    { success: true, data: { handoff_url: `${base}/api/handoff`, handoff_token: result.token, next: result.next } },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
};
