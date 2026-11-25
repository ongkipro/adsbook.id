import { constantTimeEqual } from "../platform/webhook-secrets.ts";
import { openCredential } from "./credential-crypto.ts";
import {
  selectProviderShippingAdvance,
  type ProviderShippingStatus,
} from "./mengantar-client.ts";
import {
  applyOrderLifecycleMutation,
  type OrderLifecycleState,
} from "./order-lifecycle.ts";

/**
 * Mengantar per-seller webhook verification, status mapping, and event processing
 * (MENGANTAR-WEBHOOK-AUTOSYNC-SPEC §3–§5, Mengantar Public API v2.0.2).
 *
 * Official contract:
 * - Signature: hex HMAC-SHA256 of `${x-timestamp}.${rawBody}` keyed with the
 *   seller's Webhook Secret, compared in constant time.
 * - Sandbox deliveries carry `x-environment: sandbox`; production deliveries
 *   omit it.
 * - `status_category` is an open-ended list; both `CANCELED` and `CANCELLED`
 *   are recorded for operator review without auto-cancelling orders.
 */
export const MENGANTAR_WEBHOOK_MAX_BODY_BYTES = 16 * 1024;
export const MENGANTAR_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;
export const MENGANTAR_WEBHOOK_RETENTION_DAYS = 30;
export const MENGANTAR_WEBHOOK_STALE_WARNING_HOURS = 48;

export type MengantarWebhookOutcome =
  | "applied"
  | "unchanged"
  | "unknown_order"
  | "unmapped";

export type MengantarWebhookPayload = {
  cnoteNo: string;
  providerOrderId: string | null;
  courier: string | null;
  serviceCode: string | null;
  statusCategory: string;
};

export type MappedWebhookCategory = {
  shippingStatus: ProviderShippingStatus | null;
  label: string;
  attention: boolean;
  mapped: boolean;
};

export type MengantarWebhookHealth = {
  lastEventAt: string | null;
  stale48hWarning: boolean;
};

type OrderMatchRow = OrderLifecycleState & {
  order_number: string;
  provider_event_at: string | null;
};

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(digest);
}

export async function computeMengantarWebhookSignature(
  timestamp: string,
  rawBody: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  return toHex(signature);
}

export async function verifyMengantarWebhookSignature(input: {
  timestamp: string;
  signature: string;
  rawBody: string;
  secret: string;
  nowMs?: number;
  maxSkewMs?: number;
}): Promise<
  | { ok: true; timestampMs: number; eventAtIso: string }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "invalid_timestamp"
        | "timestamp_out_of_window"
        | "invalid_signature";
    }
> {
  const timestamp = input.timestamp.trim();
  const signature = input.signature.trim().toLowerCase();
  if (!timestamp || !signature || !input.secret) {
    return { ok: false, reason: "missing_headers" };
  }
  if (!/^\d{10,16}$/.test(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const nowMs = input.nowMs ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? MENGANTAR_WEBHOOK_MAX_SKEW_MS;
  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "invalid_signature" };
  }
  const expected = await computeMengantarWebhookSignature(
    timestamp,
    input.rawBody,
    input.secret,
  );
  if (!constantTimeEqual(expected, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return {
    ok: true,
    timestampMs,
    eventAtIso: new Date(timestampMs).toISOString(),
  };
}

export function parseMengantarWebhookPayload(
  rawBody: string,
): MengantarWebhookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const text = (key: string, maxLen: number): string | null => {
    const value = record[key];
    if (typeof value !== "string" && typeof value !== "number") return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed.slice(0, maxLen) : null;
  };
  const cnoteNo = text("cnote_no", 120) ?? "";
  const providerOrderId = text("order_id", 120);
  const statusCategory = text("status_category", 120);
  if (!statusCategory || (!cnoteNo && !providerOrderId)) {
    return null;
  }
  return {
    cnoteNo,
    providerOrderId,
    courier: text("courier", 60),
    serviceCode: text("service_code", 60),
    statusCategory,
  };
}

/**
 * Maps Mengantar's open-ended `status_category` string (§4.3) to local status
 * evidence. Always includes a safe default branch and handles both `CANCELED`
 * and `CANCELLED` without auto-cancelling the order.
 */
export function mapMengantarWebhookStatusCategory(
  rawCategory: string,
): MappedWebhookCategory {
  const cleaned = rawCategory.trim();
  const normalized = cleaned.replace(/\s+/g, " ").toUpperCase();

  if (normalized === "PICKED UP" || normalized === "ON DELIVERY") {
    return {
      shippingStatus: "shipped",
      label: cleaned,
      attention: false,
      mapped: true,
    };
  }
  if (normalized === "DELIVERED") {
    return {
      shippingStatus: "delivered",
      label: cleaned,
      attention: false,
      mapped: true,
    };
  }
  if (normalized === "RTS") {
    return {
      shippingStatus: "returned",
      label: cleaned,
      attention: false,
      mapped: true,
    };
  }
  if (
    normalized === "PENDING PICKUP" ||
    normalized === "ACTIVE/WAITING NEXT PROCESS"
  ) {
    return {
      shippingStatus: null,
      label: cleaned,
      attention: false,
      mapped: true,
    };
  }
  if (normalized === "UNDELIVERED" || normalized === "PICKUP FAILED") {
    return {
      shippingStatus: null,
      label: `Perlu perhatian kurir (${cleaned})`,
      attention: true,
      mapped: true,
    };
  }
  if (normalized === "CANCELED" || normalized === "CANCELLED") {
    return {
      shippingStatus: null,
      label: `Pembatalan dari kurir — perlu cek operator (${cleaned})`,
      attention: true,
      mapped: true,
    };
  }
  if (normalized === "ERROR") {
    return {
      shippingStatus: null,
      label: `Status Mengantar ERROR — perlu cek`,
      attention: true,
      mapped: true,
    };
  }
  return {
    shippingStatus: null,
    label: cleaned,
    attention: false,
    mapped: false,
  };
}

export async function readMengantarWebhookSecret(
  database: D1Database,
): Promise<string> {
  try {
    const row = await database
      .prepare("SELECT mengantar_webhook_secret FROM stores ORDER BY id LIMIT 1")
      .first<{ mengantar_webhook_secret?: string | null }>();
    const opened = await openCredential(
      database,
      "mengantar_webhook_secret",
      row?.mengantar_webhook_secret,
    );
    return opened?.trim() || "";
  } catch {
    return "";
  }
}

export async function recordMengantarWebhookEvent(
  database: D1Database,
  input: {
    receivedAt: string;
    eventAt: string;
    payload: MengantarWebhookPayload;
    bodySha256: string;
    initialOutcome?: MengantarWebhookOutcome;
  },
): Promise<{ inserted: boolean; eventId: number | null }> {
  const dedupeKey = input.payload.cnoteNo || input.payload.providerOrderId || "";
  const result = await database
    .prepare(
      `INSERT OR IGNORE INTO mengantar_webhook_events
         (received_at, event_at, cnote_no, provider_order_id, status_category, body_sha256, outcome, order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      input.receivedAt,
      input.eventAt,
      dedupeKey,
      input.payload.providerOrderId,
      input.payload.statusCategory,
      input.bodySha256,
      input.initialOutcome ?? "unchanged",
    )
    .run();
  const changes = Number(result.meta?.changes ?? 0);
  return {
    inserted: changes > 0,
    eventId: changes > 0 ? Number(result.meta?.last_row_id ?? 0) || null : null,
  };
}

async function finalizeEventRow(
  database: D1Database,
  eventId: number | null,
  outcome: MengantarWebhookOutcome,
  orderId: number | null,
) {
  if (!eventId) return;
  await database
    .prepare(
      "UPDATE mengantar_webhook_events SET outcome = ?, order_id = ? WHERE id = ?",
    )
    .bind(outcome, orderId, eventId)
    .run();
}

/**
 * Applies a verified Mengantar webhook event to the matching tenant order.
 * Runs inside `waitUntil` in production so the webhook endpoint always replies
 * well under Mengantar's 5-second timeout.
 */
export async function processMengantarWebhookEvent(
  database: D1Database,
  input: {
    eventId: number | null;
    receivedAt: string;
    eventAtIso: string;
    timestampMs: number;
    payload: MengantarWebhookPayload;
  },
): Promise<{ outcome: MengantarWebhookOutcome; orderId: number | null }> {
  let order: OrderMatchRow | null = null;
  if (input.payload.cnoteNo) {
    order = await database
      .prepare(
        `SELECT id, order_number, payment_method, payment_status,
                shipping_status, courier_code, cnote_no, provider_order_id,
                stock_restored_at, shipping_channel, provider_event_at
         FROM orders
         WHERE cnote_no = ? AND shipping_status <> 'abandoned'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .bind(input.payload.cnoteNo)
      .first<OrderMatchRow>();
  }
  if (!order && input.payload.providerOrderId) {
    order = await database
      .prepare(
        `SELECT id, order_number, payment_method, payment_status,
                shipping_status, courier_code, cnote_no, provider_order_id,
                stock_restored_at, shipping_channel, provider_event_at
         FROM orders
         WHERE provider_order_id = ? AND shipping_status <> 'abandoned'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .bind(input.payload.providerOrderId)
      .first<OrderMatchRow>();
  }

  // X-7 / X-8: ignore unknown orders and external-channel orders completely.
  if (
    !order ||
    order.shipping_channel === "external" ||
    !order.provider_order_id
  ) {
    await finalizeEventRow(database, input.eventId, "unknown_order", null);
    return { outcome: "unknown_order", orderId: null };
  }

  // Ignore out-of-order deliveries older than the newest event already seen.
  const previousEventMs = order.provider_event_at
    ? Date.parse(order.provider_event_at)
    : Number.NaN;
  if (Number.isFinite(previousEventMs) && input.timestampMs < previousEventMs) {
    await finalizeEventRow(database, input.eventId, "unchanged", order.id);
    return { outcome: "unchanged", orderId: order.id };
  }

  const mapped = mapMengantarWebhookStatusCategory(input.payload.statusCategory);
  await database
    .prepare(
      `UPDATE orders
       SET provider_status_category = ?,
           provider_event_at = ?,
           provider_status_text = ?,
           provider_status_at = ?,
           provider_synced_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.payload.statusCategory,
      input.eventAtIso,
      mapped.label,
      input.eventAtIso,
      input.receivedAt,
      order.id,
    )
    .run();

  if (!mapped.mapped) {
    await finalizeEventRow(database, input.eventId, "unmapped", order.id);
    return { outcome: "unmapped", orderId: order.id };
  }

  if (!mapped.shippingStatus) {
    await finalizeEventRow(database, input.eventId, "unchanged", order.id);
    return { outcome: "unchanged", orderId: order.id };
  }

  const nextStatus = selectProviderShippingAdvance(
    order.shipping_status,
    mapped.shippingStatus,
  );
  if (!nextStatus) {
    await finalizeEventRow(database, input.eventId, "unchanged", order.id);
    return { outcome: "unchanged", orderId: order.id };
  }

  const transition = await applyOrderLifecycleMutation(
    database,
    order,
    { shippingStatus: nextStatus },
    database
      .prepare(
        `UPDATE orders
         SET shipping_status = ?
         WHERE id = ? AND shipping_status = ?`,
      )
      .bind(nextStatus, order.id, order.shipping_status),
  );
  const outcome: MengantarWebhookOutcome = transition.updated
    ? "applied"
    : "unchanged";
  await finalizeEventRow(database, input.eventId, outcome, order.id);
  return { outcome, orderId: order.id };
}

/** D-5: purge webhook event rows older than 30 days in the hourly tenant alarm. */
export async function purgeExpiredMengantarWebhookEvents(
  database: D1Database,
  now = new Date(),
  retentionDays = MENGANTAR_WEBHOOK_RETENTION_DAYS,
): Promise<number> {
  const cutoffIso = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = await database
    .prepare("DELETE FROM mengantar_webhook_events WHERE received_at < ?")
    .bind(cutoffIso)
    .run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * A-2: reads latest webhook activity and checks whether a configured store has
 * active Mengantar orders older than 48h without any webhook event in 48h
 * (the main symptom of Mengantar's automatic 20-failure webhook pause).
 */
export async function readMengantarWebhookHealth(
  database: D1Database,
  configured: boolean,
  now = new Date(),
): Promise<MengantarWebhookHealth> {
  try {
    const latest = await database
      .prepare(
        "SELECT received_at FROM mengantar_webhook_events ORDER BY id DESC LIMIT 1",
      )
      .first<{ received_at?: string | null }>();
    const lastEventAt = latest?.received_at ?? null;
    if (!configured) {
      return { lastEventAt, stale48hWarning: false };
    }
    const cutoffIso = new Date(
      now.getTime() - MENGANTAR_WEBHOOK_STALE_WARNING_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const recentEvent =
      Boolean(lastEventAt) && Date.parse(lastEventAt!) >= Date.parse(cutoffIso);
    if (recentEvent) {
      return { lastEventAt, stale48hWarning: false };
    }
    const activeOld = await database
      .prepare(
        `SELECT 1 AS yes FROM orders
         WHERE provider_order_id IS NOT NULL
           AND COALESCE(shipping_channel, 'mengantar') = 'mengantar'
           AND shipping_status IN ('processing', 'shipped')
           AND COALESCE(provider_dispatched_at, created_at) <= ?
         LIMIT 1`,
      )
      .bind(cutoffIso)
      .first<{ yes?: number }>();
    return { lastEventAt, stale48hWarning: Boolean(activeOld?.yes) };
  } catch {
    return { lastEventAt: null, stale48hWarning: false };
  }
}
