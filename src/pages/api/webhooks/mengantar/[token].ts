import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../lib/api.ts";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import {
  MENGANTAR_WEBHOOK_MAX_BODY_BYTES,
  parseMengantarWebhookPayload,
  processMengantarWebhookEvent,
  readMengantarWebhookSecret,
  recordMengantarWebhookEvent,
  sha256Hex,
  verifyMengantarWebhookSignature,
} from "../../../../lib/mengantar-webhook.ts";
import { checkRateLimit, getClientIp } from "../../../../lib/rate-limit.ts";
import { tenantDatabase } from "../../../../lib/tenant-database.ts";
import { verifyWebhook } from "../../../../platform/webhook-secrets.ts";

export const prerender = false;

/**
 * Per-tenant Mengantar order status webhook (MENGANTAR-WEBHOOK-AUTOSYNC-SPEC
 * W-1..W-7, Mengantar Public API v2.0.2).
 *
 * Two security layers:
 * 1. Path token in `PLATFORM_DB.webhook_secrets` scoped to `<slug>.adsbook.my.id`
 *    only (SEC-5 / API-7), verified before touching the tenant DB.
 * 2. HMAC-SHA256 `x-signature` over `${x-timestamp}.${rawBody}` keyed with the
 *    seller's ADR-040 sealed `stores.mengantar_webhook_secret`, with ±5 min
 *    replay window and sandbox-header rejection in production.
 *
 * Raw body, secret, and path token are never logged (OBS-1, W-5).
 */
export const POST: APIRoute = async ({ request, locals, params }) => {
  const runtimeEnv = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const verdict = await verifyWebhook(
    runtimeEnv?.PLATFORM_DB as D1Database | undefined,
    locals.tenantContext,
    "mengantar",
    typeof params.token === "string" ? params.token : undefined,
  );
  if (verdict === "not_found") return jsonError("Not found", 404);
  if (verdict === "unauthorized") return jsonError("Unauthorized", 401);

  const environmentHeader = (request.headers.get("x-environment") || "").trim().toLowerCase();
  const allowSandbox = String(runtimeEnv?.ALLOW_MENGANTAR_SANDBOX_WEBHOOK ?? "").trim() === "1";
  if (environmentHeader === "sandbox" && !allowSandbox) {
    return jsonError("Sandbox webhook ditolak di production.", 403, {
      code: "SANDBOX_WEBHOOK_REJECTED",
    });
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MENGANTAR_WEBHOOK_MAX_BODY_BYTES) {
    return jsonError("Payload webhook terlalu besar.", 413);
  }

  const database = tenantDatabase(locals);
  if (!database?.prepare) {
    return jsonError("Penyimpanan webhook belum tersedia.", 503);
  }

  const rawBody = await request.text().catch(() => "");
  if (!rawBody.trim()) {
    return jsonError("Payload webhook kosong.", 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MENGANTAR_WEBHOOK_MAX_BODY_BYTES) {
    return jsonError("Payload webhook terlalu besar.", 413);
  }

  const tenantId = locals.tenantContext?.tenantId ?? null;
  const requestId = request.headers.get("cf-ray") || crypto.randomUUID();

  const clientIp = getClientIp(request.headers);
  const [perAddress, global] = await Promise.all([
    checkRateLimit(database, `mengantar-webhook:${clientIp}`, 30, 60_000),
    checkRateLimit(database, "mengantar-webhook-global:store", 600, 60 * 60_000),
  ]);
  if (!perAddress.allowed || !global.allowed) {
    console.warn("mengantar-webhook-rate-limited", {
      tenant_id: tenantId,
      request_id: requestId,
      global: !global.allowed,
    });
    return jsonError("Terlalu banyak webhook.", 429, { code: "RATE_LIMITED" });
  }

  // W-6: store without a saved Webhook Secret returns 401 and writes nothing.
  const secret = await readMengantarWebhookSecret(database);
  if (!secret) {
    return jsonError("Webhook Secret Mengantar belum dikonfigurasi.", 401);
  }

  const signatureCheck = await verifyMengantarWebhookSignature({
    timestamp: request.headers.get("x-timestamp") ?? "",
    signature: request.headers.get("x-signature") ?? "",
    rawBody,
    secret,
  });
  if (!signatureCheck.ok) {
    return jsonError("Tanda tangan webhook tidak valid.", 401, {
      code: signatureCheck.reason.toUpperCase(),
    });
  }

  const payload = parseMengantarWebhookPayload(rawBody);
  if (!payload) {
    return jsonError("Payload webhook Mengantar tidak valid.", 400);
  }

  const receivedAt = new Date().toISOString();
  const bodyHash = await sha256Hex(rawBody);
  const recorded = await recordMengantarWebhookEvent(database, {
    receivedAt,
    eventAt: signatureCheck.eventAtIso,
    payload,
    bodySha256: bodyHash,
  });

  if (!recorded.inserted) {
    console.info("mengantar-webhook-processed", {
      tenant_id: tenantId,
      request_id: requestId,
      outcome: "duplicate",
      status_category: payload.statusCategory,
    });
    return jsonOk({ received: true, duplicate: true });
  }

  const runProcessing = async () => {
    try {
      const processed = await processMengantarWebhookEvent(database, {
        eventId: recorded.eventId,
        receivedAt,
        eventAtIso: signatureCheck.eventAtIso,
        timestampMs: signatureCheck.timestampMs,
        payload,
      });
      console.info("mengantar-webhook-processed", {
        tenant_id: tenantId,
        request_id: requestId,
        outcome: processed.outcome,
        status_category: payload.statusCategory,
      });
    } catch (error) {
      console.error("mengantar-webhook-process-failed", {
        tenant_id: tenantId,
        request_id: requestId,
        status_category: payload.statusCategory,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  // W-3 / T-8: acknowledge immediately (<5s Mengantar SLA) via waitUntil when available.
  const waitUntil = locals.cfContext?.waitUntil;
  if (typeof waitUntil === "function") {
    waitUntil.call(locals.cfContext, runProcessing());
  } else {
    await runProcessing();
  }

  return jsonOk({ received: true, duplicate: false });
};
