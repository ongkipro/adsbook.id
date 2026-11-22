import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { getClientIp } from "../../../lib/rate-limit.ts";
import { completeOwnerReset, requestOwnerReset } from "../../../platform/owner-reset.ts";

export const prerender = false;

const NO_STORE = { "cache-control": "no-store" };

/**
 * adsbook.id/lupa-password's form post (`src/platform/owner-reset.ts`): one
 * endpoint, two actions. Same-origin only; every answer is `no-store`.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ success: false, error: "Forbidden request origin" }, { status: 403, headers: NO_STORE });
  }
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ success: false, error: "Payload tidak valid." }, { status: 400, headers: NO_STORE });
  const ip = getClientIp(request.headers);
  if (body.action === "request_code") {
    const result = await requestOwnerReset(env, { email: body.email, turnstileToken: body.turnstile_token }, ip);
    if (result.status !== 200) {
      return Response.json({ success: false, error: result.error, errors: "errors" in result ? result.errors ?? {} : {} }, { status: result.status, headers: NO_STORE });
    }
    return Response.json({ success: true, challenge_id: result.challengeId }, { status: 200, headers: NO_STORE });
  }
  if (body.action === "reset") {
    const result = await completeOwnerReset(
      env,
      { email: body.email, challengeId: body.challenge_id, emailCode: body.email_code, password: body.password, turnstileToken: body.turnstile_token },
      ip,
    );
    if (result.status !== 200) {
      return Response.json({ success: false, error: result.error, errors: "errors" in result ? result.errors ?? {} : {} }, { status: result.status, headers: NO_STORE });
    }
    return Response.json({ success: true }, { status: 200, headers: NO_STORE });
  }
  return Response.json({ success: false, error: "Payload tidak valid." }, { status: 400, headers: NO_STORE });
};
