import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { handleBillingWebhook, type BillingEnv } from "../../../../../platform/billing.ts";

export const prerender = false;

/**
 * API-9: the platform AutoLaris account's callback for subscription invoices
 * (ADR-041). Evidence only: it triggers an Advice check, never a transition.
 * Reached without a session or Origin (`isPlatformWebhookPath`); the token in
 * the path is the authentication.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = (getRuntimeEnv(locals) ?? {}) as BillingEnv;
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (!platformDb) return new Response(JSON.stringify({ success: false }), { status: 503, headers });
  const text = (await request.text().catch(() => "")).slice(0, 16_384);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const result = await handleBillingWebhook(platformDb, env, String(params.token ?? ""), body);
  if (result.status === 404) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
};
