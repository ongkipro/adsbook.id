import {
  mapMengantarStatusEvidence,
  MengantarClient,
  selectProviderShippingAdvance,
} from "./mengantar-client.ts";
import {
  applyOrderLifecycleMutation,
  type OrderLifecycleState,
} from "./order-lifecycle.ts";
import { getProviderConfig } from "./provider-config.ts";

/**
 * Hourly Mengantar shipping reconciliation (MENGANTAR-WEBHOOK-AUTOSYNC-SPEC §4.4, R-1..R-3).
 *
 * One single-order sync path shared by the manual "Sinkronkan status" button in
 * `/admin/shipping` and the per-tenant hourly alarm in `tenant-maintenance.ts`.
 */
export const MENGANTAR_RECONCILE_STALE_HOURS = 6;
export const MENGANTAR_RECONCILE_BATCH_LIMIT = 25;

export type MengantarSyncOrderRow = OrderLifecycleState & {
  order_number: string;
};

export type SingleMengantarSyncOutcome = {
  orderId: number;
  orderNumber: string;
  localStatus: string;
  providerStatus: string | null;
  synced: boolean;
  updated: boolean;
  unchanged: boolean;
  error: string | null;
};

export type MengantarReconciliationSummary = {
  checked: number;
  synced: number;
  updated: number;
  unchanged: number;
  failed: number;
  skippedReason?: "billing_paused" | "digital_store" | "no_api_key";
};

/**
 * Queries Mengantar for one order's tracking state, records the observation
 * timestamp, and applies any forward-only status advance through the shared
 * order lifecycle (voiding RTS exactly once).
 */
export async function syncSingleMengantarOrder(
  db: D1Database,
  client: Pick<MengantarClient, "getOrderByTrackingId">,
  row: MengantarSyncOrderRow,
  syncedAt: string,
): Promise<SingleMengantarSyncOutcome> {
  if (row.shipping_channel === "external") {
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      localStatus: row.shipping_status,
      providerStatus: null,
      synced: false,
      updated: false,
      unchanged: false,
      error: "Order dikirim di luar Mengantar dan diperbarui secara manual.",
    };
  }
  if (!row.provider_order_id) {
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      localStatus: row.shipping_status,
      providerStatus: null,
      synced: false,
      updated: false,
      unchanged: false,
      error: "Shipment Mengantar belum dibuat.",
    };
  }
  if (!row.cnote_no) {
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      localStatus: row.shipping_status,
      providerStatus: null,
      synced: false,
      updated: false,
      unchanged: false,
      error: "Nomor resi Mengantar belum tersedia.",
    };
  }

  let providerStatus: string | null = null;
  let localStatus = row.shipping_status;
  try {
    const tracking = await client.getOrderByTrackingId(row.cnote_no);
    const evidence = mapMengantarStatusEvidence(tracking);
    providerStatus = evidence.description;
    // The category too, so a synced order reads the same as one a webhook updated, but never over
    // something newer or more specific: GET /order's generic "active" does not replace a webhook's
    // "PENDING PICKUP", and a category older than the webhook's last event (provider_event_at) is
    // kept out. A legacy flag response carries no category and leaves the stored one alone.
    const observation = await db
      .prepare(
        `UPDATE orders
         SET provider_status_text = ?, provider_status_at = ?, provider_synced_at = ?,
             provider_status_category = CASE
               WHEN ? IS NULL THEN provider_status_category
               WHEN ? IN ('ACTIVE', 'ACTIVE/WAITING NEXT PROCESS') AND provider_status_category IS NOT NULL THEN provider_status_category
               WHEN provider_event_at IS NOT NULL AND ? IS NOT NULL AND unixepoch(?) < unixepoch(provider_event_at) THEN provider_status_category
               ELSE ?
             END
         WHERE id = ?`,
      )
      .bind(
        evidence.description, evidence.occurredAt, syncedAt,
        evidence.category, evidence.category, evidence.occurredAt, evidence.occurredAt, evidence.category,
        row.id,
      )
      .run();
    if (!observation.meta?.changes) {
      throw new Error("Observasi status provider gagal disimpan.");
    }

    const nextStatus = selectProviderShippingAdvance(
      row.shipping_status,
      evidence.shippingStatus,
    );
    if (!nextStatus) {
      return {
        orderId: row.id,
        orderNumber: row.order_number,
        localStatus,
        providerStatus,
        synced: true,
        updated: false,
        unchanged: true,
        error: null,
      };
    }

    const transition = await applyOrderLifecycleMutation(
      db,
      row,
      { shippingStatus: nextStatus },
      db
        .prepare(
          `UPDATE orders
           SET shipping_status = ?
           WHERE id = ? AND shipping_status = ?`,
        )
        .bind(nextStatus, row.id, row.shipping_status),
    );
    if (transition.updated) {
      return {
        orderId: row.id,
        orderNumber: row.order_number,
        localStatus: nextStatus,
        providerStatus,
        synced: true,
        updated: true,
        unchanged: false,
        error: null,
      };
    }
    const current = await db
      .prepare("SELECT shipping_status FROM orders WHERE id = ? LIMIT 1")
      .bind(row.id)
      .first<{ shipping_status: string }>();
    localStatus = current?.shipping_status || row.shipping_status;
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      localStatus,
      providerStatus,
      synced: true,
      updated: false,
      unchanged: true,
      error: null,
    };
  } catch (error) {
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      localStatus,
      providerStatus,
      synced: false,
      updated: false,
      unchanged: false,
      error:
        error instanceof Error
          ? error.message
          : "Gagal menyinkronkan status Mengantar.",
    };
  }
}

/**
 * Reconciles up to 25 stale Mengantar orders (`processing` / `shipped`, synced
 * more than 6 hours ago or never synced) for one tenant alarm run (R-2, R-3).
 * Skips Preview/expired stores (ADR-041), digital-only stores, stores without a
 * Mengantar API key, and all `external`-channel orders.
 */
export async function reconcileStaleMengantarOrders(
  db: D1Database,
  locals: App.Locals,
  now = new Date(),
  options: {
    staleHours?: number;
    limit?: number;
    client?: Pick<MengantarClient, "getOrderByTrackingId">;
  } = {},
): Promise<MengantarReconciliationSummary> {
  if (locals.billing?.adSignalsPaused) {
    return { checked: 0, synced: 0, updated: 0, unchanged: 0, failed: 0, skippedReason: "billing_paused" };
  }
  if (locals.tenant?.catalogMode === "digital") {
    return { checked: 0, synced: 0, updated: 0, unchanged: 0, failed: 0, skippedReason: "digital_store" };
  }

  let client = options.client ?? null;
  if (!client) {
    const provider = (await getProviderConfig(db, locals)).mengantar;
    if (!provider.apiKey) {
      return { checked: 0, synced: 0, updated: 0, unchanged: 0, failed: 0, skippedReason: "no_api_key" };
    }
    client = new MengantarClient(provider.apiKey, provider.baseUrl);
  }

  const staleHours = options.staleHours ?? MENGANTAR_RECONCILE_STALE_HOURS;
  const limit = Math.min(
    Math.max(1, options.limit ?? MENGANTAR_RECONCILE_BATCH_LIMIT),
    MENGANTAR_RECONCILE_BATCH_LIMIT,
  );
  const cutoffIso = new Date(now.getTime() - staleHours * 60 * 60 * 1000).toISOString();
  const syncedAt = now.toISOString();

  const stale = await db
    .prepare(
      `SELECT id, order_number, payment_method, payment_status,
              shipping_status, courier_code, cnote_no, provider_order_id,
              stock_restored_at, shipping_channel
       FROM orders
       WHERE provider_order_id IS NOT NULL
         AND cnote_no IS NOT NULL
         AND COALESCE(shipping_channel, 'mengantar') = 'mengantar'
         AND shipping_status IN ('processing', 'shipped')
         AND (provider_synced_at IS NULL OR provider_synced_at <= ?)
       ORDER BY COALESCE(provider_synced_at, '') ASC, id ASC
       LIMIT ?`,
    )
    .bind(cutoffIso, limit)
    .all<MengantarSyncOrderRow>();

  const rows = stale.results ?? [];
  let synced = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    const outcome = await syncSingleMengantarOrder(db, client, row, syncedAt);
    if (outcome.synced) synced += 1;
    if (outcome.updated) updated += 1;
    if (outcome.unchanged) unchanged += 1;
    if (outcome.error) failed += 1;
  }

  return {
    checked: rows.length,
    synced,
    updated,
    unchanged,
    failed,
  };
}
