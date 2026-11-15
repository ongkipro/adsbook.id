/**
 * The platform's own hourly job (T-24): retention on the control plane
 * (PRIV-4), stale custom hostnames (DOM-5) and the start of due purges. It
 * touches only `PLATFORM_DB` and, through the injected client, Cloudflare's
 * custom-hostname API; tenant data is each tenant's own alarm's business.
 *
 * Limits, each kept to the day and tested one day inside and one outside:
 * - `tenant_events` older than 1 year (365 days; the table's delete trigger
 *   refuses anything younger);
 * - `tenant_usage_daily` older than 13 months;
 * - handoff tokens 7 days past their expiry;
 * - custom hostnames still `pending` 7 days after they were added, deleted at
 *   Cloudflare first (a pending hostname still counts toward usage), then
 *   revoked here;
 * - tenants whose `purge_after` has passed move to `purging`, which the purge
 *   pipeline (T-29) carries on from.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes one Cloudflare custom hostname by id; T-25 supplies the real client. */
export type CustomHostnameDeleter = (cloudflareId: string) => Promise<void>;

export type PlatformJobResult = {
  tenantEvents: number;
  usageRows: number;
  handoffTokens: number;
  staleHostnames: number;
  purgesStarted: number;
  hostnameReapSkipped: boolean;
};

/** The ISO day 13 calendar months before `now` (UTC). */
export function thirteenMonthsBefore(now: Date): string {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, now.getUTCDate()));
  return cutoff.toISOString().slice(0, 10);
}

export async function runPlatformJobs(
  platformDb: D1Database,
  now: Date,
  deleteCustomHostname?: CustomHostnameDeleter,
): Promise<PlatformJobResult> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const changes = (result: D1Result) => Number(result.meta?.changes ?? 0);

  const [events, usage, handoff] = await platformDb.batch([
    platformDb.prepare("DELETE FROM tenant_events WHERE at < ?").bind(iso(now.getTime() - 365 * DAY_MS)),
    platformDb.prepare("DELETE FROM tenant_usage_daily WHERE day < ?").bind(thirteenMonthsBefore(now)),
    platformDb.prepare("DELETE FROM handoff_tokens WHERE expires_at < ?").bind(iso(now.getTime() - 7 * DAY_MS)),
  ]);

  let staleHostnames = 0;
  const hostnameReapSkipped = !deleteCustomHostname;
  if (deleteCustomHostname) {
    const stale = (
      await platformDb
        .prepare(
          `SELECT host, cf_custom_hostname_id FROM tenant_hosts
           WHERE kind = 'custom' AND status = 'pending' AND created_at < ? LIMIT 100`,
        )
        .bind(iso(now.getTime() - 7 * DAY_MS))
        .all<{ host: string; cf_custom_hostname_id: string | null }>()
    ).results;
    for (const row of stale) {
      try {
        if (row.cf_custom_hostname_id) await deleteCustomHostname(row.cf_custom_hostname_id);
        await platformDb
          .prepare("UPDATE tenant_hosts SET status = 'revoked', revoked_at = ? WHERE host = ? AND status = 'pending'")
          .bind(now.toISOString(), row.host)
          .run();
        staleHostnames += 1;
      } catch (error) {
        // Left pending: the next run tries again rather than dropping our record
        // of a hostname Cloudflare may still bill for.
        console.error("platform-job-hostname-reap-failed", { host: row.host, error: String(error) });
      }
    }
  } else {
    console.info("platform-job-hostname-reap-skipped", { reason: "no Cloudflare client" });
  }

  // The audit row and the state change in one batch: a purge never starts unrecorded.
  const due = "purge_after IS NOT NULL AND purge_after < ? AND status NOT IN ('purging', 'purged')";
  const [, purges] = await platformDb.batch([
    platformDb
      .prepare(
        `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
         SELECT id, 'purge_started', 'platform-job', ?, json_object('purge_after', purge_after) FROM tenants WHERE ${due}`,
      )
      .bind(now.toISOString(), now.toISOString()),
    platformDb.prepare(`UPDATE tenants SET status = 'purging' WHERE ${due}`).bind(now.toISOString()),
  ]);

  return {
    tenantEvents: changes(events),
    usageRows: changes(usage),
    handoffTokens: changes(handoff),
    staleHostnames,
    purgesStarted: changes(purges),
    hostnameReapSkipped,
  };
}
