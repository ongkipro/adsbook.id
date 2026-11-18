/**
 * Transactional outbox for the TikTok Events API, mirroring `capi-outbox.ts`
 * (tracking chapter 11 §2.4): an event is recorded in the tenant's store
 * before it is sent, claimed with a lease so two drains never send one row
 * twice, retried by `decideTikTokRetry`, and drained by the hourly tenant
 * alarm. Keyed on (event_name, event_id) like Meta's since 0057.
 *
 * It also owns when an order becomes a TikTok `CompletePayment`
 * (`tiktokOrderQualifies`): COD at order creation or at delivery, as the
 * seller chose in `/admin/ads/tiktok`; every other method only once paid. The
 * `event_id` is the order number on the browser leg, the server leg and every
 * retry, so TikTok deduplicates the pair.
 *
 * ADR-041: everything here reads its configuration through
 * `getStoreAdsConfig`, which is empty for a store in Preview Mode or past its
 * grace, so such a store enqueues and sends nothing.
 */
import { catalogProductIdOrNull } from "./catalog-feed.ts";
import { matchableCustomerEmail } from "./autolaris-payment.ts";
import { parseClickIds } from "./click-ids.ts";
import { parseMetaOrderContext } from "./meta-order-context.ts";
import { isVoidOrder } from "./order-lifecycle.ts";
import { getStoreAdsConfig, normalizeTikTokCodTrigger, type TikTokCodTrigger } from "./store-ads.ts";
import {
  buildTikTokUserData,
  decideTikTokRetry,
  describeTikTokResult,
  sendTikTokEvents,
  tikTokProperties,
  type TikTokContent,
  type TikTokEventData,
} from "./tiktok-events.ts";

export type TikTokDestination = { pixelId: string; accessToken: string };

type OutboxRow = {
  id: number;
  event_id: string;
  event_name: string;
  payload: string;
  attempts: number;
  max_attempts: number;
};

const MAX_DRAIN_BATCH = 10;
export const TIKTOK_DRAIN_LEASE_MS = 5 * 60_000;
export const TIKTOK_CRON_DRAIN_BATCHES = 3;
const UNREADABLE_PAYLOAD = "payload tidak dapat dibaca";

/** Records the event as pending; false when (event_name, event_id) is already known. */
export async function enqueueTikTokEvent(database: D1Database, event: TikTokEventData, now = new Date()): Promise<boolean> {
  const stamp = now.toISOString();
  const result = await database
    .prepare(
      `INSERT OR IGNORE INTO tiktok_event_outbox
         (event_id, event_name, payload, status, next_retry_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(event.event_id, event.event, JSON.stringify(event), stamp, stamp, stamp)
    .run();
  return Boolean(result.meta?.changes);
}

async function transmit(
  database: D1Database,
  row: OutboxRow,
  destination: TikTokDestination,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let event: TikTokEventData;
  try {
    event = JSON.parse(row.payload) as TikTokEventData;
  } catch {
    await database
      .prepare(`UPDATE tiktok_event_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(UNREADABLE_PAYLOAD, new Date().toISOString(), row.id)
      .run();
    return false;
  }
  // Never a test code here: a live conversion carrying one would land in
  // Test Events and never count. The test code is for `sendTikTokTestEvent` only.
  const result = await sendTikTokEvents(destination.pixelId, destination.accessToken, [event], undefined, fetchImpl);
  const decision = decideTikTokRetry(result, row.attempts, row.max_attempts);
  const now = Date.now();
  const sent = decision.status === "sent";
  await database
    .prepare(
      `UPDATE tiktok_event_outbox
          SET status = ?, attempts = attempts + ?, last_error = ?, next_retry_at = ?,
              sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      decision.status,
      sent ? 0 : 1,
      sent ? null : describeTikTokResult(result),
      new Date(now + decision.delayMs).toISOString(),
      decision.status,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      row.id,
    )
    .run();
  return sent;
}

/** Sends one enqueued event now, under the same lease the drain uses. */
export async function deliverTikTokEvent(
  database: D1Database,
  eventName: string,
  eventId: string,
  destination: TikTokDestination,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const row = await database
    .prepare(
      `UPDATE tiktok_event_outbox
          SET next_retry_at = ?
        WHERE event_name = ? AND event_id = ? AND status = 'pending'
          AND next_retry_at <= ? AND attempts < max_attempts
       RETURNING id, event_id, event_name, payload, attempts, max_attempts`,
    )
    .bind(new Date(now.getTime() + TIKTOK_DRAIN_LEASE_MS).toISOString(), eventName, eventId, now.toISOString())
    .first<OutboxRow>();
  if (!row) return false;
  return transmit(database, row, destination, fetchImpl);
}

/** One bounded batch of due rows, CompletePayment first, claimed before it is sent. */
export async function drainTikTokOutbox(
  database: D1Database,
  destination: TikTokDestination,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const due = await database
    .prepare(
      `UPDATE tiktok_event_outbox
          SET next_retry_at = ?
        WHERE id IN (
          SELECT id FROM tiktok_event_outbox
           WHERE status = 'pending' AND next_retry_at <= ? AND attempts < max_attempts
           ORDER BY CASE WHEN event_name = 'CompletePayment' THEN 0 ELSE 1 END, id ASC
           LIMIT ?
        )
       RETURNING id, event_id, event_name, payload, attempts, max_attempts`,
    )
    .bind(new Date(now.getTime() + TIKTOK_DRAIN_LEASE_MS).toISOString(), now.toISOString(), MAX_DRAIN_BATCH)
    .all<OutboxRow>();
  let sent = 0;
  for (const row of due.results ?? []) {
    if (await transmit(database, row, destination, fetchImpl)) sent += 1;
  }
  return sent;
}

/** Batch after batch while each lands in full; a short or refused batch stops it. */
export async function drainTikTokOutboxBacklog(
  database: D1Database,
  destination: TikTokDestination,
  now = new Date(),
  maxBatches = TIKTOK_CRON_DRAIN_BATCHES,
): Promise<number> {
  let sent = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const landed = await drainTikTokOutbox(database, destination, now);
    sent += landed;
    if (landed < MAX_DRAIN_BATCH) break;
  }
  return sent;
}

const OUTBOX_RETENTION_DAYS = 30;

export async function purgeExpiredTikTokOutboxEvents(database: D1Database, now = new Date()): Promise<number> {
  const result = await database
    .prepare(
      `DELETE FROM tiktok_event_outbox
        WHERE status IN ('sent', 'failed')
          AND unixepoch(updated_at) < unixepoch(?, '-${OUTBOX_RETENTION_DAYS} days')`,
    )
    .bind(now.toISOString())
    .run();
  return Number(result.meta?.changes ?? 0);
}

export type TikTokOutboxDepth = {
  pending: number;
  failed: number;
  /** Failed inside the last 24 hours: only these keep the health alert firing. */
  recentFailed: number;
  overdue: number;
  oldestCreatedAt: string | null;
  sent: number;
  lastError: string | null;
  lastSentAt: string | null;
};

/** Longest delay `decideTikTokRetry` schedules: an overdue row older than this is not being drained. */
export const TIKTOK_MAX_BACKOFF_MS = 60 * 60_000;

/** Counters for `/admin/ads/tiktok` and `/admin/status`; null when unreadable (unknown, not zero). */
export async function readTikTokOutboxDepth(database: D1Database, now = new Date()): Promise<TikTokOutboxDepth | null> {
  try {
    const row = await database
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS recent_failed,
           SUM(CASE WHEN status = 'pending' AND next_retry_at <= ? THEN 1 ELSE 0 END) AS overdue,
           MIN(CASE WHEN status IN ('pending', 'failed') THEN created_at END) AS oldest_created_at,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           MAX(sent_at) AS last_sent_at,
           (SELECT last_error FROM tiktok_event_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 1) AS last_error
         FROM tiktok_event_outbox`,
      )
      .bind(new Date(now.getTime() - 24 * 60 * 60_000).toISOString(), now.toISOString())
      .first<{
        pending: number | null;
        failed: number | null;
        recent_failed: number | null;
        overdue: number | null;
        oldest_created_at: string | null;
        sent: number | null;
        last_sent_at: string | null;
        last_error: string | null;
      }>();
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      recentFailed: Number(row?.recent_failed ?? 0),
      overdue: Number(row?.overdue ?? 0),
      oldestCreatedAt: row?.oldest_created_at ?? null,
      sent: Number(row?.sent ?? 0),
      lastSentAt: row?.last_sent_at ?? null,
      lastError: row?.last_error ?? null,
    };
  } catch (error) {
    console.error("tiktok-outbox-depth-unreadable", error);
    return null;
  }
}

/** TikTok deduplicates and attributes inside seven days; older rows are not offered back. */
export const TIKTOK_REQUEUE_MAX_AGE_DAYS = 7;
const RECOVERABLE_PREDICATE = `status = 'failed'
   AND COALESCE(last_error, '') <> '${UNREADABLE_PAYLOAD}'
   AND unixepoch(created_at) >= unixepoch(?, '-${TIKTOK_REQUEUE_MAX_AGE_DAYS} days')`;

/** Called by `/api/admin/ads` only after a test event proved the destination works. */
export async function requeueRecoverableTikTokEvents(database: D1Database, now = new Date(), limit = 500): Promise<number> {
  const bounded = Math.max(1, Math.min(1000, Math.trunc(limit) || 500));
  const stamp = now.toISOString();
  const result = await database
    .prepare(
      `UPDATE tiktok_event_outbox
          SET status = 'pending', attempts = 0, last_error = NULL, next_retry_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM tiktok_event_outbox WHERE ${RECOVERABLE_PREDICATE}
           ORDER BY CASE WHEN event_name = 'CompletePayment' THEN 0 ELSE 1 END, id ASC
           LIMIT ?
        )`,
    )
    .bind(stamp, stamp, stamp, bounded)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function countRecoverableTikTokEvents(database: D1Database, now = new Date()): Promise<number> {
  const row = await database
    .prepare(`SELECT COUNT(*) AS recoverable FROM tiktok_event_outbox WHERE ${RECOVERABLE_PREDICATE}`)
    .bind(now.toISOString())
    .first<{ recoverable: number }>();
  return Number(row?.recoverable ?? 0);
}

const PAID_STATUSES = new Set(["paid", "settled", "success"]);

export type TikTokOrderState = {
  payment_method: string;
  payment_status: string;
  shipping_status: string;
  stock_restored_at?: string | null;
};

/**
 * Whether this order is a TikTok CompletePayment now. The one rule the
 * server enqueue, the sweep and `/thanks` (through `/api/order-status`) share,
 * so the browser and server legs never disagree.
 */
export function tiktokOrderQualifies(order: TikTokOrderState, trigger: TikTokCodTrigger): boolean {
  if (order.shipping_status === "abandoned") return false;
  if (isVoidOrder(order)) return false;
  if (order.payment_method === "cod") {
    return trigger === "delivered" ? order.shipping_status === "delivered" : true;
  }
  return PAID_STATUSES.has(String(order.payment_status).toLowerCase());
}

type OrderRow = TikTokOrderState & {
  order_number: string;
  customer_phone: string;
  customer_email: string | null;
  ad_click_ids: string | null;
  meta_request_context: string | null;
  product_value: number;
};

export type TikTokOrderResult =
  | { status: "queued"; delivered: boolean }
  | { status: "deduplicated" }
  | { status: "skipped"; reason: string };

/**
 * Enqueue (and try once) the CompletePayment for one order, from the order
 * row alone. Never throws on a missing configuration; the caller decides
 * whether a thrown D1 error matters (it must never undo an order or payment).
 */
export async function enqueueTikTokCompletePayment(
  database: D1Database,
  locals: App.Locals,
  orderId: number,
  options: { eventTime?: number; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<TikTokOrderResult> {
  const ads = await getStoreAdsConfig(locals);
  if (!ads.tiktokPixelId || !ads.tiktokAccessToken) return { status: "skipped", reason: "tiktok-not-configured" };
  const order = await database
    .prepare(
      `SELECT o.order_number, o.payment_method, o.payment_status, o.shipping_status, o.stock_restored_at,
              o.customer_phone, o.customer_email, o.ad_click_ids, o.meta_request_context,
              (SELECT COALESCE(SUM(oi.unit_price * oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS product_value
         FROM orders o WHERE o.id = ? LIMIT 1`,
    )
    .bind(orderId)
    .first<OrderRow>();
  if (!order) return { status: "skipped", reason: "order-not-found" };
  if (!tiktokOrderQualifies(order, ads.tiktokCodTrigger)) return { status: "skipped", reason: "order-not-qualified" };

  const items = await database
    .prepare(
      `SELECT p.id AS product_id, p.title, MAX(oi.unit_price) AS price, SUM(oi.quantity) AS quantity
         FROM order_items oi
         INNER JOIN product_variants pv ON pv.id = oi.variant_id
         INNER JOIN products p ON p.id = pv.product_id
        WHERE oi.order_id = ?
        GROUP BY p.id, p.title
        ORDER BY p.id`,
    )
    .bind(orderId)
    .all<{ product_id: number; title: string; price: number; quantity: number }>();
  const contents: TikTokContent[] = [];
  for (const item of items.results ?? []) {
    // The same id the catalogue feed and the browser leg use; an old id that
    // cannot form one simply carries no content_id rather than breaking the event.
    const contentId = catalogProductIdOrNull(item.product_id);
    if (!contentId) continue;
    contents.push({ content_id: contentId, content_name: item.title, price: Number(item.price) || 0, quantity: Number(item.quantity) || 1 });
  }

  const siteUrl = locals.tenant?.siteUrl || "https://example.com";
  const context = parseMetaOrderContext(order.meta_request_context);
  const clickIds = parseClickIds(order.ad_click_ids);
  const now = options.now ?? new Date();
  // With the delivered trigger the sale happens at delivery, which is now;
  // a caller's order-creation time (Meta's COD sweep) does not apply.
  const deliveredCod = order.payment_method === "cod" && ads.tiktokCodTrigger === "delivered";
  const event: TikTokEventData = {
    event: "CompletePayment",
    event_time: (!deliveredCod && options.eventTime) || Math.floor(now.getTime() / 1000),
    event_id: order.order_number,
    user: await buildTikTokUserData({
      phone: order.customer_phone,
      email: matchableCustomerEmail(order.customer_email, siteUrl),
      externalId: context.externalId,
      ttclid: clickIds.ttclid,
      ttp: context.ttp || clickIds._ttp,
      ip: context.clientIp,
      userAgent: context.userAgent,
    }),
    properties: tikTokProperties({ value: Number(order.product_value ?? 0), orderNumber: order.order_number, contents }),
    page: { url: new URL("/thanks", siteUrl).toString() },
  };
  const queued = await enqueueTikTokEvent(database, event, now);
  if (!queued) return { status: "deduplicated" };
  const destination = { pixelId: ads.tiktokPixelId, accessToken: ads.tiktokAccessToken };
  const delivered = await deliverTikTokEvent(database, "CompletePayment", order.order_number, destination, now, options.fetchImpl);
  return { status: "queued", delivered };
}

/** As Meta's COD sweep: younger orders are left to submit and `/thanks`. */
export const TIKTOK_SWEEP_MIN_AGE_MS = 30 * 60_000;
/** TikTok deduplicates a browser and server event sharing `event_id` inside 48 hours. */
export const TIKTOK_SWEEP_ORDER_CREATED_MAX_AGE_MS = 48 * 60 * 60_000;
/**
 * lazy: a delivered COD order is looked for among orders placed in the last
 * 14 days — longer than a normal courier run, short enough that switching the
 * trigger never sends a backlog of old sales. Upgrade path: a delivered-at
 * stamp on the order, and a window on that instead.
 */
export const TIKTOK_SWEEP_DELIVERED_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const TIKTOK_SWEEP_LIMIT = 50;

/**
 * The hourly net: COD orders whose CompletePayment never left (the buyer's
 * tab closed before `/thanks`, or, with the `delivered` trigger, the package
 * was delivered since the last run). Orders already in the outbox are skipped
 * by the query; the order number keys every leg, so a late `/thanks` is a no-op.
 */
export async function sweepTikTokCompletePayments(
  database: D1Database,
  locals: App.Locals,
  now = new Date(),
): Promise<number> {
  const ads = await getStoreAdsConfig(locals);
  if (!ads.tiktokPixelId || !ads.tiktokAccessToken) return 0;
  const delivered = ads.tiktokCodTrigger === "delivered";
  const oldest = new Date(now.getTime() - (delivered ? TIKTOK_SWEEP_DELIVERED_MAX_AGE_MS : TIKTOK_SWEEP_ORDER_CREATED_MAX_AGE_MS));
  const newest = new Date(now.getTime() - TIKTOK_SWEEP_MIN_AGE_MS);
  const missed = await database
    .prepare(
      `SELECT o.id, o.created_at
         FROM orders o
        WHERE o.created_at >= ? AND o.created_at <= ?
          AND o.payment_method = 'cod'
          AND ${delivered ? "o.shipping_status = 'delivered'" : "o.shipping_status NOT IN ('abandoned', 'cancelled', 'returned', 'failed')"}
          AND o.payment_status NOT IN ('failed', 'refunded', 'cancelled')
          AND o.stock_restored_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM tiktok_event_outbox t
             WHERE t.event_name = 'CompletePayment' AND t.event_id = o.order_number
          )
        ORDER BY o.id
        LIMIT ?`,
    )
    .bind(oldest.toISOString(), newest.toISOString(), TIKTOK_SWEEP_LIMIT)
    .all<{ id: number; created_at: string }>();
  let queued = 0;
  for (const row of missed.results ?? []) {
    const placedAt = Date.parse(row.created_at);
    try {
      const result = await enqueueTikTokCompletePayment(database, locals, row.id, {
        // Created: the buyer bought when they ordered. Delivered: the sale is
        // the delivery, which this run is the first to see.
        eventTime: !delivered && Number.isFinite(placedAt) ? Math.floor(placedAt / 1000) : undefined,
        now,
      });
      if (result.status === "queued") queued += 1;
    } catch (error) {
      console.error("tiktok-sweep-failed", { orderId: row.id, error });
    }
  }
  return queued;
}

/**
 * The store's COD trigger alone, for `/api/order-status` (polled every minute
 * by an open payment page, so it reads one column, never the sealed token).
 */
export async function readTikTokCodTrigger(database: D1Database): Promise<TikTokCodTrigger> {
  try {
    const row = await database
      .prepare("SELECT tiktok_cod_trigger FROM stores ORDER BY id LIMIT 1")
      .first<{ tiktok_cod_trigger: string | null }>();
    return normalizeTikTokCodTrigger(row?.tiktok_cod_trigger);
  } catch {
    return "order_created";
  }
}
