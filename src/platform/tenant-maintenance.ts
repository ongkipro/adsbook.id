import { encryptStoredCredentials } from "../lib/credential-crypto.ts";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { tenantKv } from "./keys.ts";
import { purgeExpiredAbandonedOrders } from "../lib/order-persistence.ts";
import {
  alertsFromOperationalHealth,
  evaluateOperationalAlerts,
} from "../lib/operational-alerts.ts";
import { collectOperationalHealth, recordSchedulerRun } from "../lib/operational-health.ts";
import { readSetupRequiredLeft, writeHealthSnapshot } from "../lib/health-snapshot.ts";
import { backfillReceiverScores } from "../lib/rts-scoring.ts";
import { purgeExpiredRateLimits } from "../lib/rate-limit.ts";
import { reconcileNativeLandingPages } from "../lib/landing-pages.ts";
import { activeNativeLandingPages } from "../lib/native-landing-pages.ts";
import { purgeExpiredNotifications } from "../lib/notifications.ts";
import {
  expirePendingPaymentTransactions,
  purgeExpiredAutoLarisCallbacks,
  reconcileAutoLarisPaymentStatuses,
} from "../lib/autolaris-payment.ts";
import { enqueuePurchaseForPaidOrder, sweepMissedCodPurchases } from "../lib/paid-order-purchase.ts";
import { readStoreIdentity, resolveTenantConfig } from "../lib/tenant.ts";
import { drainCapiOutboxBacklog, purgeExpiredCapiOutboxEvents } from "../lib/capi-outbox.ts";
import { getStoreAdsConfig } from "../lib/store-ads.ts";
import { runPluginCron, sealPluginSecrets } from "../plugins/registry.ts";
import {
  drainGoogleAdsConversionOutbox,
  purgeExpiredGoogleAdsConversions,
  loadGoogleAdsOfflineConfig,
  reconcileGoogleAdsConversions,
} from "../lib/google-ads-offline.ts";

/**
 * One tenant's hourly maintenance, on that tenant's own store and identity
 * (TEN-5). The caller has checked the store is on this release's schema
 * (MIG-1). A tenant whose identity cannot be read skips its run: this throws
 * before any step, and the alarm logs the failure with the tenant id.
 */
export async function runTenantMaintenance(
  env: CloudflareRuntimeEnv,
  database: D1Database,
  tenantId: string,
  scheduledTime: number,
  context: ExecutionContext,
  primaryHost?: string | null,
  /** ADR-041: a store in Preview Mode or past its grace sends no ad signal. */
  adSignalsPaused = false,
) {
  const identity = await readStoreIdentity(database);
  if (identity.state !== "installed") {
    throw new Error(`TENANT_IDENTITY_UNAVAILABLE: ${identity.state}`);
  }
  // No step takes the ones after it down: payment reconciliation, both outbox
  // drains and the health evaluation each run even when an earlier step hit a
  // transient D1 or provider error. The failure is logged and reads as -1.
  const housekeeping = async (label: string, run: () => Promise<number>) => {
    try {
      return await run();
    } catch (error) {
      console.error(label, error);
      return -1;
    }
  };
  // The panel's "Tugas terjadwal" signal: proof this clock still runs at all.
  // A D1 column on the status row, not KV (A-379), stamped before any later
  // step can fail.
  // ADR-040 (T-48): seal any credential still in plaintext, or under an older
  // key version, before anything below reads one. Cheap when nothing is left.
  const sealedCredentials = await housekeeping("scheduled-credential-seal-failed", async () =>
    (await encryptStoredCredentials(database)).sealed + (await sealPluginSecrets(database)),
  );
  await housekeeping("scheduled-heartbeat-failed", async () => {
    await recordSchedulerRun(database, new Date(scheduledTime));
    return 0;
  });
  const purgedAbandonedOrders = await housekeeping(
    "scheduled-abandoned-order-purge-failed",
    () => purgeExpiredAbandonedOrders(database, new Date(scheduledTime)),
  );
  const purgedRateLimitWindows = await housekeeping(
    "scheduled-rate-limit-purge-failed",
    () => purgeExpiredRateLimits(database, new Date(scheduledTime)),
  );
  const expiredPaymentInstructions = await housekeeping(
    "scheduled-payment-expiry-failed",
    () => expirePendingPaymentTransactions(database, new Date(scheduledTime)),
  );
  const purgedProviderCallbacks = await housekeeping(
    "scheduled-callback-purge-failed",
    () => purgeExpiredAutoLarisCallbacks(database, new Date(scheduledTime)),
  );
  const purgedNotifications = await housekeeping(
    "scheduled-notification-purge-failed",
    () => purgeExpiredNotifications(database, new Date(scheduledTime)),
  );
  const purgedCapiOutboxEvents = await housekeeping(
    "scheduled-capi-outbox-purge-failed",
    () => purgeExpiredCapiOutboxEvents(database, new Date(scheduledTime)),
  );
  const purgedGoogleAdsConversions = await housekeeping(
    "scheduled-google-ads-purge-failed",
    () => purgeExpiredGoogleAdsConversions(database, new Date(scheduledTime)),
  );
  // The native register reached the table only when an operator opened the
  // landing-page list, so a page deployed since stayed out of the sitemap and
  // could not take a product page until then. The re-sync writes only what
  // changed, so running it hourly costs nothing when nothing did.
  // Only when this build carries native pages (T-24): otherwise every
  // tenant's hourly run would read its whole product table for nothing.
  if (activeNativeLandingPages().length > 0) {
    await housekeeping("scheduled-native-landing-reconcile-failed", async () => {
      await reconcileNativeLandingPages(database);
      return 0;
    });
  }
  // Payment truth for QRIS/VA. The retired webhook never answered; the
  // provider's Advice endpoint does, and this is the only clock that asks it.
  // A transaction is marked paid solely when the provider's own response says
  // so — an operator can still reconcile by hand from /admin/payments, and
  // every transition either way is audited.
  // The store's identity as a request resolves it: the tenant's own `stores`
  // row and primary host, never a default (TEN-5, PR-6).
  const scheduledLocals = {
    runtimeEnv: env,
    tenantDb: database,
    tenant: resolveTenantConfig(identity.row, primaryHost ?? undefined),
    cfContext: context,
    ...(adSignalsPaused ? { billing: { state: "expired" as const, adSignalsPaused: true } } : {}),
  } satisfies App.Locals;
  let autoLarisReconciliation = {
    checked: 0,
    pending: 0,
    unproven: 0,
    failed: 0,
    paidOrderIds: [] as number[],
    unrecognisedPaidStatuses: [] as string[],
  };
  try {
    autoLarisReconciliation = await reconcileAutoLarisPaymentStatuses(
      database,
      scheduledLocals,
      new Date(scheduledTime),
    );
  } catch (error) {
    console.error("scheduled-autolaris-advice-failed", error);
  }
  for (const orderId of autoLarisReconciliation.paidOrderIds) {
    try {
      await enqueuePurchaseForPaidOrder(database, scheduledLocals, orderId);
    } catch (error) {
      // Payment truth is authoritative. Conversion delivery is independently
      // retried by its outbox and must never roll a paid order back.
      console.error("scheduled-paid-order-purchase-failed", { orderId, error });
    }
  }
  // The outbox had no clock of its own: `drainCapiOutbox` was reachable only
  // from `/api/meta-event` and `/api/v1/tracking/events`, so a delivery that
  // failed was retried when the next visitor arrived rather than when its
  // backoff expired. Backoff caps at an hour, which assumes someone will be
  // along within the hour — not true for a store between campaigns, and the
  // health check below was already counting the overdue rows without anything
  // acting on them.
  // A COD buyer who never reached /thanks sent no Purchase from either leg
  // (audit 2026-11-10, F-1). Delivered inline; the drain below retries a miss.
  const sweptCodPurchases = await housekeeping("scheduled-cod-purchase-sweep-failed", () =>
    sweepMissedCodPurchases(database, scheduledLocals, new Date(scheduledTime)),
  );
  const drainedCapiEvents = await housekeeping("scheduled-capi-drain-failed", async () => {
    const ads = await getStoreAdsConfig(scheduledLocals);
    return ads.metaPixelId && ads.metaCapiToken
      ? drainCapiOutboxBacklog(database, ads.metaPixelId, ads.metaCapiToken, new Date(scheduledTime))
      : 0;
  });
  // The tenant's own upload settings (T-45); an unreadable row uploads nothing.
  const googleAdsOffline = adSignalsPaused ? null : await loadGoogleAdsOfflineConfig(database).catch((error) => {
    console.error("scheduled-google-ads-config-failed", { tenant_id: tenantId, error: String(error) });
    return null;
  });
  const queuedGoogleAdsConversions = googleAdsOffline
    ? await housekeeping("scheduled-google-ads-reconcile-failed", () =>
        reconcileGoogleAdsConversions(database, googleAdsOffline, new Date(scheduledTime)),
      )
    : 0;
  const drainedGoogleAdsConversions = googleAdsOffline
    ? await housekeeping("scheduled-google-ads-drain-failed", () =>
        drainGoogleAdsConversionOutbox(database, googleAdsOffline),
      )
    : 0;
  // Active plugins only (ADR-028); a store with none does one cheap read.
  // runPluginCron isolates each plugin's failure; this catch is for the read.
  const pluginCron = await runPluginCron(database, env, new Date(scheduledTime)).catch((error) => {
    console.error("scheduled-plugin-cron-failed", error);
    return {};
  });

  // Receiver Score is whitelisted per Mengantar account; orders taken while it
  // was refused (or never opened in /admin) score themselves here.
  const backfilledReceiverScores = await housekeeping("scheduled-receiver-score-backfill-failed", () =>
    backfillReceiverScores(database, scheduledLocals),
  );

  const health = await collectOperationalHealth(database, scheduledLocals);
  const alerts = await evaluateOperationalAlerts(
    alertsFromOperationalHealth(health),
    {
      // The tenant's own alert state (TEN-3): one tenant's firing never mutes another's.
      store: tenantKv(env, tenantId),
      // The platform's alert channel (a Worker secret), not a tenant value.
      webhookUrl: String(env.OPS_ALERT_WEBHOOK_URL ?? "").trim(),
      // No request here, so the tenant names itself from its own store.
      source: scheduledLocals.tenant.siteUrl,
    },
  );

  console.info("operational-health-scheduled", {
    tenant_id: tenantId,
    overall: health.overall,
    schemaState: health.build.schemaState,
    sealedCredentials,
    purgedAbandonedOrders,
    purgedRateLimitWindows,
    expiredPaymentInstructions,
    purgedProviderCallbacks,
    purgedNotifications,
    purgedCapiOutboxEvents,
    purgedGoogleAdsConversions,
    backfilledReceiverScores,
    autoLarisReconciliation: {
      checked: autoLarisReconciliation.checked,
      paid: autoLarisReconciliation.paidOrderIds.length,
      pending: autoLarisReconciliation.pending,
      unproven: autoLarisReconciliation.unproven,
      failed: autoLarisReconciliation.failed,
      // The provider's success code with a settlement word the allowlist does
      // not know. Non-empty here is the observation SCR1 needs, not an error.
      unrecognisedPaidStatuses: autoLarisReconciliation.unrecognisedPaidStatuses,
    },
    sweptCodPurchases,
    drainedCapiEvents,
    queuedGoogleAdsConversions,
    drainedGoogleAdsConversions,
    pluginCron,
    alerts: alerts.map(({ id, state, reason, transition, notification }) => ({
      id,
      state,
      reason,
      transition,
      notification,
    })),
  });

  // The admin status icon reads this one row instead of collecting health on
  // every page (A39). Last, and isolated: its failure is logged and nothing
  // else, and a run that failed to collect never reaches it, so the previous
  // snapshot stays rather than a blank one.
  await housekeeping("scheduled-health-snapshot-failed", async () => {
    await writeHealthSnapshot(
      database,
      health,
      await readSetupRequiredLeft(database, scheduledLocals),
    );
    return 0;
  });
}
