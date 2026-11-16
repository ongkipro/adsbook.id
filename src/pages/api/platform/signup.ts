import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { getClientIp } from "../../../lib/rate-limit.ts";
import { signup } from "../../../platform/signup.ts";
import { cookieValue, registrationEventId, sendCompleteRegistration } from "../../../platform/site/site.ts";
import { notifyOperator } from "../../../platform/notify.ts";

export const prerender = false;

/**
 * API-4: `POST /api/platform/signup` on the platform host — the signup page's
 * own form post, not a public API. 201 carries the store URL and the IAM-8
 * handoff (token in this response body only; it is posted on to the seller
 * host and never placed in a URL).
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  // Same-origin only: this is the signup page talking to its own host.
  const origin = request.headers.get("origin");
  if (origin !== url.origin) {
    return Response.json({ success: false, error: "Forbidden request origin" }, { status: 403 });
  }
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ success: false, error: "Payload tidak valid." }, { status: 400 });
  const result = await signup(
    env,
    {
      storeName: body.store_name,
      slug: body.slug,
      email: body.email,
      password: body.password,
      terms: body.terms,
      turnstileToken: body.turnstile_token,
    },
    getClientIp(request.headers),
  );
  if (result.status !== 201) {
    return Response.json({ success: false, error: result.error, errors: "errors" in result ? result.errors ?? {} : {} }, { status: result.status });
  }
  // T-40: the server half of CompleteRegistration, with the browser's event id;
  // after the response, and never able to affect the signup that succeeded.
  const signal = sendCompleteRegistration(env, () => ({
    eventId: registrationEventId(body.event_id),
    email: result.email,
    sourceUrl: `${url.origin}/daftar`,
    ip: getClientIp(request.headers),
    userAgent: request.headers.get("user-agent"),
    fbp: cookieValue(request, "_fbp"),
    fbc: cookieValue(request, "_fbc"),
  }));
  // T-44 (PR-29): the operator hears of every new seller, once.
  const notice = notifyOperator(env, env.PLATFORM_DB as D1Database, {
    tenantId: result.tenantId,
    slug: result.host.split(".")[0],
    kind: "signup",
    storeName: typeof body.store_name === "string" ? body.store_name : null,
  });
  if (locals.cfContext) {
    locals.cfContext.waitUntil(signal);
    locals.cfContext.waitUntil(notice);
  } else await Promise.all([signal, notice]);
  // The seller host answers on the same scheme and port as this platform host (local dev keeps its port).
  const base = `${url.protocol}//${result.host}${url.port ? `:${url.port}` : ""}`;
  return Response.json(
    {
      success: true,
      data: {
        store_url: base,
        login_url: `${base}/hello`,
        handoff_url: result.handoffToken ? `${base}/api/handoff` : null,
        handoff_token: result.handoffToken || null,
        email: result.email,
      },
    },
    // The body carries a one-time handoff token: no cache may keep it (T-28 review).
    { status: 201, headers: { "cache-control": "no-store" } },
  );
};
