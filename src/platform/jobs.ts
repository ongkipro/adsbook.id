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
 * - signup email challenges once they no longer count toward their address's
 *   hourly send cap (T-58; `deleteRetiredChallenges`);
 * - custom hostnames still `pending` 7 days after they were added, deleted at
 *   Cloudflare first (a pending hostname still counts toward usage), then
 *   revoked here;
 * - tenants whose `purge_after` has passed move to `purging`, which the purge
 *   pipeline (T-29) carries on from.
 */
import { deleteRetiredChallenges } from "./signup-verification.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes one Cloudflare custom hostname by id; T-25 supplies the real client. */
export type CustomHostnameDeleter = (cloudflareId: string) => Promise<void>;

export type PlatformJobResult = {
  tenantEvents: number;
  usageRows: number;
  handoffTokens: number;
  signupChallenges: number;
  staleHostnames: number;
  purgesStarted: number;
  hostnameReapSkipped: boolean;
};

/** Rows each retention step removes per run; a backlog drains over several runs. */
export const JOB_BATCH = 1000;
/** Purges started per run. */
export const PURGE_BATCH = 20;
/** Cloudflare deletions per run (each is one outbound call). */
export const HOSTNAME_BATCH = 50;

/** The ISO day 13 calendar months before `now` (UTC), clamped to that month's last day. */
export function thirteenMonthsBefore(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - 13;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cutoff = new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay)));
  return cutoff.toISOString().slice(0, 10);
}

/** One step's failure is logged and the next step still runs. */
async function step(label: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    console.error(label, String(error));
    return -1;
  }
}

export async function runPlatformJobs(
  platformDb: D1Database,
  now: Date,
  deleteCustomHostname?: CustomHostnameDeleter,
): Promise<PlatformJobResult> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const changes = (result: D1Result) => Number(result.meta?.changes ?? 0);
  const run = async (sql: string, ...values: unknown[]) =>
    changes(await platformDb.prepare(sql).bind(...values).run());

  const tenantEvents = await step("platform-job-events-failed", () =>
    run(
      "DELETE FROM tenant_events WHERE id IN (SELECT id FROM tenant_events WHERE at < ? ORDER BY at LIMIT ?)",
      iso(now.getTime() - 365 * DAY_MS),
      JOB_BATCH,
    ),
  );
  const usageRows = await step("platform-job-usage-failed", () =>
    run(
      "DELETE FROM tenant_usage_daily WHERE rowid IN (SELECT rowid FROM tenant_usage_daily WHERE day < ? LIMIT ?)",
      thirteenMonthsBefore(now),
      JOB_BATCH,
    ),
  );
  const handoffTokens = await step("platform-job-handoff-failed", () =>
    run(
      "DELETE FROM handoff_tokens WHERE token_hash IN (SELECT token_hash FROM handoff_tokens WHERE expires_at < ? LIMIT ?)",
      iso(now.getTime() - 7 * DAY_MS),
      JOB_BATCH,
    ),
  );

  const signupChallenges = await step("platform-job-signup-challenges-failed", async () =>
    changes(await deleteRetiredChallenges(platformDb, now.getTime(), JOB_BATCH).run()),
  );

  const hostnameReapSkipped = !deleteCustomHostname;
  const staleHostnames = deleteCustomHostname
    ? await step("platform-job-hostnames-failed", () => reapStaleHostnames(platformDb, now, deleteCustomHostname))
    : (console.info("platform-job-hostname-reap-skipped", { reason: "no Cloudflare client" }), 0);

  const purgesStarted = await step("platform-job-purge-failed", async () => {
    const due = (
      await platformDb
        .prepare(
          `SELECT id FROM tenants
           WHERE purge_after IS NOT NULL AND purge_after < ? AND status NOT IN ('purging', 'purged')
           ORDER BY purge_after LIMIT ?`,
        )
        .bind(now.toISOString(), PURGE_BATCH)
        .all<{ id: string }>()
    ).results;
    let started = 0;
    for (const { id } of due) {
      // The audit row and the state change in one batch: a purge never starts
      // unrecorded, and a tenant that changed meanwhile is left alone.
      const [, update] = await platformDb.batch([
        platformDb
          .prepare(
            `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
             SELECT id, 'purge_started', 'platform-job', ?, json_object('purge_after', purge_after) FROM tenants
             WHERE id = ? AND purge_after IS NOT NULL AND purge_after < ? AND status NOT IN ('purging', 'purged')`,
          )
          .bind(now.toISOString(), id, now.toISOString()),
        platformDb
          .prepare(
            `UPDATE tenants SET status = 'purging'
             WHERE id = ? AND purge_after IS NOT NULL AND purge_after < ? AND status NOT IN ('purging', 'purged')`,
          )
          .bind(id, now.toISOString()),
      ]);
      started += changes(update);
    }
    return started;
  });

  return { tenantEvents, usageRows, handoffTokens, signupChallenges, staleHostnames, purgesStarted, hostnameReapSkipped };
}

/**
 * DOM-5. The row is claimed first (`pending` → `revoked`), so activation,
 * which only promotes a `pending` row, can never race the external delete.
 * The Cloudflare id is cleared once Cloudflare confirms; a revoked row that
 * still holds one is retried on the next run (Cloudflare bills until then).
 */
async function reapStaleHostnames(
  platformDb: D1Database,
  now: Date,
  deleteCustomHostname: CustomHostnameDeleter,
): Promise<number> {
  const cutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const claimed = (
    await platformDb
      .prepare(
        `UPDATE tenant_hosts SET status = 'revoked', revoked_at = ?
         WHERE host IN (SELECT host FROM tenant_hosts
           WHERE kind = 'custom' AND status = 'pending' AND created_at < ? LIMIT ?)
         RETURNING host`,
      )
      .bind(now.toISOString(), cutoff, HOSTNAME_BATCH)
      .all<{ host: string }>()
  ).results.length;
  const toDelete = (
    await platformDb
      .prepare(
        `SELECT host, cf_custom_hostname_id FROM tenant_hosts
         WHERE kind = 'custom' AND status = 'revoked' AND cf_custom_hostname_id IS NOT NULL
         ORDER BY revoked_at LIMIT ?`,
      )
      .bind(HOSTNAME_BATCH)
      .all<{ host: string; cf_custom_hostname_id: string }>()
  ).results;
  for (const row of toDelete) {
    try {
      await deleteCustomHostname(row.cf_custom_hostname_id);
      await platformDb
        .prepare("UPDATE tenant_hosts SET cf_custom_hostname_id = NULL WHERE host = ? AND status = 'revoked'")
        .bind(row.host)
        .run();
    } catch (error) {
      console.error("platform-job-hostname-reap-failed", { host: row.host, error: String(error) });
      // To the back of the queue: rows Cloudflare keeps refusing never hold
      // every slot of the next run (`revoked_at` then reads "last attempt").
      await platformDb
        .prepare("UPDATE tenant_hosts SET revoked_at = ? WHERE host = ? AND status = 'revoked'")
        .bind(now.toISOString(), row.host)
        .run()
        .catch(() => undefined);
    }
  }
  return claimed;
}
