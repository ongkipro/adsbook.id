import type { ExecutionContext } from "@cloudflare/workers-types";
import { CMS_VERSION } from "../lib/version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { armTenantAlarm, openTenantDb, TenantUnavailableError } from "./tenant-db.ts";
import { runPlatformJobs } from "./jobs.ts";
import { noticeDomainIfActive, noticeStuckDomains, notifyOperator, notifyPlatform } from "./notify.ts";
import { pollPendingDomains } from "./domain-poll.ts";
import { checkTrustPositif } from "./trust-watch.ts";
import { pollOpenInvoices, subscriptionCalendar } from "./billing.ts";
import { resolveAuthSecret } from "../lib/auth-secret.ts";
import { runPurges } from "./purge.ts";
import { deleteHostnameRef, hostnameApiFromEnv, probeHost } from "./hostnames.ts";
import { BACKUP_ALERT_UTC_HOUR, backupKey, runDailyPlatformBackup } from "./backup.ts";

/** MIG-1: tenants migrated by the cron per run, oldest schema first. */
export const CRON_MIGRATION_BATCH = 50;
/**
 * Alarms checked per run. Alarms re-arm themselves; this is the safety net, so
 * a fleet larger than one batch is swept over several hours (a stateless
 * rotation by the hour), and the run stays inside one invocation's budget.
 */
export const CRON_ARM_BATCH = 200;

/**
 * The platform cron (MULTI-TENANT-DESIGN §8). It runs no tenant's
 * maintenance itself — each tenant's `TenantStore` alarm does, in its own
 * invocation (TEN-5). It:
 * 1. migrates up to `CRON_MIGRATION_BATCH` active tenants whose schema is
 *    behind this release and that received no request, each through the T-18
 *    protocol (bookmark first; `openTenantDb` records the new version);
 * 2. arms the hourly alarm of every active tenant that has none;
 * 3. runs the platform's own retention job (`src/platform/jobs.ts`).
 * Before all of it, the day's `PLATFORM_DB` backup goes to R2 once
 * (`src/platform/backup.ts`).
 * One tenant's failure is logged with its id and the next tenant runs.
 */
export async function runPlatformCron(
  env: CloudflareRuntimeEnv,
  scheduledTime: number,
  context: ExecutionContext,
): Promise<{ migrated: string[]; armed: number; failed: string[] }> {
  const platformDb = env.PLATFORM_DB;
  if (!platformDb) {
    console.error("scheduled-no-platform-bindings");
    return { migrated: [], armed: 0, failed: [] };
  }
  // T-30: first, in its own try — a broken migration or job below never costs the day's backup.
  try {
    const backup = await runDailyPlatformBackup(env.BACKUP_BUCKET, platformDb, new Date(scheduledTime));
    if (backup.status !== "exists") console.info("scheduled-platform-backup", backup);
  } catch (error) {
    console.error("scheduled-platform-backup-failed", String(error));
    const at = new Date(scheduledTime);
    // Retried every hour; the operator hears once a day, after a morning of failures.
    if (at.getUTCHours() >= BACKUP_ALERT_UTC_HOUR) {
      context.waitUntil(
        notifyPlatform(
          env as unknown as Record<string, unknown>,
          platformDb,
          `platform_backup_failed:${backupKey(at)}`,
          `Backup harian PLATFORM_DB gagal (${backupKey(at)}); dicoba lagi tiap jam. Cek log scheduled-platform-backup-failed.`,
        ),
      );
    }
  }
  await ensureControlPlane(platformDb);
  const target = CMS_VERSION.schemaVersion;
  const failed: string[] = [];

  const behind = (
    await platformDb
      .prepare(
        `SELECT id, cache_version FROM tenants WHERE status = 'active' AND schema_version < ?
         ORDER BY schema_version, id LIMIT ?`,
      )
      .bind(target, CRON_MIGRATION_BATCH)
      .all<{ id: string; cache_version: number }>()
  ).results;
  const migrated: string[] = [];
  for (const { id, cache_version } of behind) {
    try {
      await openTenantDb(env, { tenantId: id, cacheVersion: Number(cache_version) }, target);
      migrated.push(id);
    } catch (error) {
      failed.push(id);
      console.error("scheduled-tenant-migration-failed", {
        tenant_id: id,
        reason: error instanceof TenantUnavailableError ? error.reason : "migration_failed",
      });
    }
  }

  const activeCount = Number(
    (await platformDb.prepare("SELECT COUNT(*) AS n FROM tenants WHERE status = 'active'").first<{ n: number }>())?.n ?? 0,
  );
  const slices = Math.max(1, Math.ceil(activeCount / CRON_ARM_BATCH));
  const slice = Math.floor(scheduledTime / 3_600_000) % slices;
  const active = (
    await platformDb
      .prepare("SELECT id FROM tenants WHERE status = 'active' ORDER BY id LIMIT ? OFFSET ?")
      .bind(CRON_ARM_BATCH, slice * CRON_ARM_BATCH)
      .all<{ id: string }>()
  ).results;
  let armed = 0;
  for (const { id } of active) {
    try {
      if (await armTenantAlarm(env, id)) armed += 1;
    } catch (error) {
      if (!failed.includes(id)) failed.push(id);
      console.error("scheduled-tenant-arm-failed", { tenant_id: id, error: String(error) });
    }
  }

  try {
    // DOM-5: stale custom hostnames are deleted at Cloudflare with the platform's client.
    const hostnames = hostnameApiFromEnv(env as unknown as Record<string, unknown>);
    const jobs = await runPlatformJobs(platformDb, new Date(scheduledTime), hostnames ? (reference) => deleteHostnameRef(hostnames, reference) : undefined);
    console.info("scheduled-platform-jobs", jobs);
    // T-26: purges in progress (and stale provisioning rows) carry on.
    const purges = await runPurges(env as unknown as Record<string, unknown>, new Date(scheduledTime), {
      deleteCustomHostname: hostnames ? (reference) => deleteHostnameRef(hostnames, reference) : undefined,
    });
    console.info("scheduled-purges", purges);
    // T-44: custom domains still failing after 24 hours reach the operator once.
    const stuck = await noticeStuckDomains(env as unknown as Record<string, unknown>, platformDb, new Date(scheduledTime));
    if (stuck) console.info("scheduled-domain-notices", { sent: stuck });
    // Paduka 2026-11-16: pending custom domains go live without the seller
    // coming back — refreshed, and once active promoted to primary after the
    // HTTPS probe, which is keyed by each tenant's own session key.
    if (hostnames) {
      const record = env as unknown as Record<string, unknown>;
      const polled = await pollPendingDomains(platformDb, hostnames, {
        secretFor: async (tenantId) => {
          const tenant = await platformDb.prepare("SELECT cache_version FROM tenants WHERE id = ?").bind(tenantId).first<{ cache_version: number }>();
          if (!tenant) return null;
          const database = await openTenantDb(env, { tenantId, cacheVersion: Number(tenant.cache_version) }, CMS_VERSION.schemaVersion);
          return resolveAuthSecret(database, tenantId);
        },
        probe: (host, secret) => probeHost(host, secret),
        onActive: (tenantId, slug, view) => noticeDomainIfActive(record, platformDb, { tenantId, slug }, view, (task) => context.waitUntil(task)),
      });
      if (polled.checked) console.info("scheduled-domain-poll", polled);
    }
    // ADR-041: subscription invoices are settled only through Advice; the
    // cron asks about open and late ones every hour, then tells the operator
    // which stores end within three days or are in their grace.
    const record = env as unknown as Record<string, unknown>;
    const billingRun = await pollOpenInvoices(platformDb, record, new Date(scheduledTime));
    if (billingRun.checked) console.info("scheduled-billing-advice", billingRun);
    const calendar = await subscriptionCalendar(platformDb, new Date(scheduledTime));
    for (const row of calendar.ending) {
      context.waitUntil(notifyOperator(record, platformDb, { tenantId: row.tenantId, slug: row.slug, kind: "subscription_ending", onceKey: row.endsAt }));
    }
    for (const row of calendar.grace) {
      context.waitUntil(notifyOperator(record, platformDb, { tenantId: row.tenantId, slug: row.slug, kind: "subscription_grace", onceKey: row.endsAt }));
    }
    // Once a day (01:07 UTC, 08:07 WIB): are the platform's own IPs on Komdigi's Trust+ list?
    if (new Date(scheduledTime).getUTCHours() === 1) {
      const watch = await checkTrustPositif(env as unknown as Record<string, unknown>, platformDb, new Date(scheduledTime));
      if (watch) console.info("scheduled-trustpositif", { checked: watch.checked, blocked: watch.blocked.length });
    }
  } catch (error) {
    console.error("scheduled-platform-jobs-failed", String(error));
  }
  return { migrated, armed, failed };
}

