/**
 * The purge pipeline (T-26, PRIV-4, MULTI-TENANT-DESIGN §3.1 and the
 * operations table): for each `purging` tenant, custom hostnames at
 * Cloudflare → R2 prefix → KV prefix → the tenant's store (alarm and data) →
 * its control-plane rows. Every step is idempotent and bounded; a step that
 * cannot finish this run stops the tenant's purge until the next one.
 *
 * A tenant that never became active (no `signup` event) is deleted outright
 * at the end, so its slug is free again; one that was active ends as the
 * `purged` tombstone (never routable, slug not reused in v1).
 *
 * The job also moves a `provisioning` row older than 15 minutes to
 * `purging`: a Worker that died mid-signup must not hold a slug forever.
 */
import { purgeTenantKv, purgeTenantR2 } from "./keys.ts";
import { purgeTenantStore } from "./tenant-db.ts";

export const STALE_PROVISIONING_MS = 15 * 60 * 1000;
/**
 * Between fencing a tenant and the first destructive sweep: longer than any
 * request or alarm admitted before the fence can still be running (a Durable
 * Object alarm has the longest wall time, 15 minutes), so nothing it writes
 * lands after the sweep.
 */
export const PURGE_DRAIN_MS = 16 * 60 * 1000;
export const PURGE_TENANTS_PER_RUN = 5;
/**
 * After a purge completes, its R2 and KV prefixes are swept again for this
 * long. A request admitted before the fence that outlives the drain window
 * can still write an object or a key; the sweep removes it. (A late write to
 * the emptied store fails: its schema is gone.)
 */
export const POST_PURGE_SWEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const POST_PURGE_SWEEP_BATCH = 50;

export type PurgeDeps = {
  /** Deletes a Cloudflare custom hostname by stored reference (`deleteHostnameRef`). */
  deleteCustomHostname?: (reference: string) => Promise<void>;
};

export type PurgeResult = { staleProvisioning: number; completed: string[]; pending: string[] };

/** One tenant's purge; true when everything of it is gone. */
export async function purgeTenant(
  env: Record<string, unknown>,
  platformDb: D1Database,
  tenantId: string,
  now: Date,
  deps: PurgeDeps = {},
): Promise<boolean> {
  // 0. Fence, then drain. The tenant is already unroutable (`purging`); every
  // host is revoked and the cache version bumped, and the destructive steps
  // wait until anything admitted before the fence has finished.
  const fence = await platformDb
    .prepare("SELECT at FROM tenant_events WHERE tenant_id = ? AND kind = 'purge_fenced' ORDER BY id LIMIT 1")
    .bind(tenantId)
    .first<{ at: string }>();
  if (!fence) {
    await platformDb.batch([
      platformDb
        .prepare(
          `UPDATE tenant_hosts SET status = 'revoked', is_primary = 0, revoked_at = COALESCE(revoked_at, ?)
           WHERE tenant_id = ? AND status != 'revoked'`,
        )
        .bind(now.toISOString(), tenantId),
      platformDb.prepare("UPDATE tenants SET cache_version = cache_version + 1 WHERE id = ? AND status = 'purging'").bind(tenantId),
      platformDb
        .prepare(
          `INSERT INTO tenant_events (tenant_id, kind, actor, at)
           SELECT id, 'purge_fenced', 'platform-job', ? FROM tenants WHERE id = ? AND status = 'purging'`,
        )
        .bind(now.toISOString(), tenantId),
    ]);
    return false;
  }
  if (now.getTime() < Date.parse(fence.at) + PURGE_DRAIN_MS) return false;

  // 1. Custom hostnames at Cloudflare.
  const held = (
    await platformDb
      .prepare("SELECT host, cf_custom_hostname_id AS cf FROM tenant_hosts WHERE tenant_id = ? AND cf_custom_hostname_id IS NOT NULL")
      .bind(tenantId)
      .all<{ host: string; cf: string }>()
  ).results;
  if (held.length && !deps.deleteCustomHostname) {
    console.error("purge-waits-for-cloudflare", { tenant_id: tenantId, hostnames: held.length });
    return false;
  }
  for (const row of held) {
    try {
      await deps.deleteCustomHostname!(row.cf);
      await platformDb.prepare("UPDATE tenant_hosts SET cf_custom_hostname_id = NULL WHERE host = ?").bind(row.host).run();
    } catch (error) {
      console.error("purge-hostname-failed", { tenant_id: tenantId, host: row.host, error: String(error) });
      return false;
    }
  }

  // 2–3. Shared resources, bounded per run.
  const r2 = await purgeTenantR2(env, tenantId);
  const kv = await purgeTenantKv(env, tenantId);
  if (!r2.done || !kv.done) return false;

  // 4. The tenant's own store: every row and its alarm.
  await purgeTenantStore(env, tenantId);

  // 5. Control-plane rows that belong to the tenant.
  const everActive = await platformDb
    .prepare("SELECT 1 AS yes FROM tenant_events WHERE tenant_id = ? AND kind = 'signup' LIMIT 1")
    .bind(tenantId)
    .first<{ yes: number }>();
  await platformDb.batch([
    platformDb
      .prepare("INSERT INTO purge_sweeps (tenant_id, completed_at) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET completed_at = excluded.completed_at")
      .bind(tenantId, now.toISOString()),
    platformDb.prepare("DELETE FROM webhook_secrets WHERE tenant_id = ?").bind(tenantId),
    platformDb.prepare("DELETE FROM handoff_tokens WHERE tenant_id = ?").bind(tenantId),
    platformDb.prepare("DELETE FROM migration_bookmarks WHERE tenant_id = ?").bind(tenantId),
    platformDb.prepare("DELETE FROM tenant_health WHERE tenant_id = ?").bind(tenantId),
    platformDb.prepare("DELETE FROM tenant_usage_daily WHERE tenant_id = ?").bind(tenantId),
    platformDb.prepare("DELETE FROM operator_notices WHERE tenant_id = ?").bind(tenantId),
    ...(everActive
      ? [
          platformDb
            .prepare("UPDATE tenants SET status = 'purged', cache_version = cache_version + 1 WHERE id = ? AND status = 'purging'")
            .bind(tenantId),
          platformDb
            .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at) VALUES (?, 'purged', 'platform-job', ?)")
            .bind(tenantId, now.toISOString()),
        ]
      : [
          // Never active: no tombstone, so the slug and hosts are free for "coba lagi".
          platformDb.prepare("DELETE FROM tenant_hosts WHERE tenant_id = ?").bind(tenantId),
          platformDb.prepare("DELETE FROM tenants WHERE id = ? AND status = 'purging'").bind(tenantId),
          platformDb
            .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at) VALUES (?, 'purge_completed', 'platform-job', ?)")
            .bind(tenantId, now.toISOString()),
        ]),
  ]);
  return true;
}

export async function runPurges(
  env: Record<string, unknown>,
  now: Date,
  deps: PurgeDeps = {},
): Promise<PurgeResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  if (!platformDb) return { staleProvisioning: 0, completed: [], pending: [] };

  const cutoff = new Date(now.getTime() - STALE_PROVISIONING_MS).toISOString();
  const [, stale] = await platformDb.batch([
    platformDb
      .prepare(
        `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
         SELECT id, 'provision_failed', 'platform-job', ?, json_object('step', 'stale') FROM tenants
         WHERE status = 'provisioning' AND created_at < ?`,
      )
      .bind(now.toISOString(), cutoff),
    platformDb.prepare("UPDATE tenants SET status = 'purging' WHERE status = 'provisioning' AND created_at < ?").bind(cutoff),
  ]);

  // Rotated by the hour, so tenants whose purge keeps waiting (a Cloudflare
  // delete that fails) never hold every slot of every run.
  const purgingCount = Number(
    (await platformDb.prepare("SELECT COUNT(*) AS n FROM tenants WHERE status = 'purging'").first<{ n: number }>())?.n ?? 0,
  );
  const slices = Math.max(1, Math.ceil(purgingCount / PURGE_TENANTS_PER_RUN));
  const slice = Math.floor(now.getTime() / 3_600_000) % slices;
  const purging = (
    await platformDb
      .prepare("SELECT id FROM tenants WHERE status = 'purging' ORDER BY created_at, id LIMIT ? OFFSET ?")
      .bind(PURGE_TENANTS_PER_RUN, slice * PURGE_TENANTS_PER_RUN)
      .all<{ id: string }>()
  ).results;
  const completed: string[] = [];
  const pending: string[] = [];
  for (const { id } of purging) {
    try {
      (await purgeTenant(env, platformDb, id, now, deps) ? completed : pending).push(id);
    } catch (error) {
      pending.push(id);
      console.error("purge-failed", { tenant_id: id, error: String(error) });
    }
  }
  // Post-purge sweep (see POST_PURGE_SWEEP_MS). Each run gives at least half
  // its slots to repeat sweeps (least recently swept first) and the rest to
  // fresh completions, each class filling what the other leaves; `swept_at`
  // is stamped on every attempt, so a tenant whose sweep fails moves to the
  // back instead of holding its slot.
  // A row leaves only after its window ended AND it was swept at least once,
  // so a fresh completion is never dropped unswept, however long it queued.
  // lazy: sustained beyond 25 completions an hour, fresh completions queue and
  // are swept later than their first hour; past that, a dedicated sweep queue.
  const since = new Date(now.getTime() - POST_PURGE_SWEEP_MS).toISOString();
  await platformDb.prepare("DELETE FROM purge_sweeps WHERE completed_at <= ? AND swept_at IS NOT NULL").bind(since).run();
  const pick = (sql: string) =>
    platformDb.prepare(sql).bind(POST_PURGE_SWEEP_BATCH).all<{ tenant_id: string }>().then((result) => result.results);
  const fresh = await pick("SELECT tenant_id FROM purge_sweeps WHERE swept_at IS NULL ORDER BY completed_at, tenant_id LIMIT ?");
  const repeat = await pick("SELECT tenant_id FROM purge_sweeps WHERE swept_at IS NOT NULL ORDER BY swept_at, tenant_id LIMIT ?");
  const half = Math.floor(POST_PURGE_SWEEP_BATCH / 2);
  const repeatTake = Math.min(repeat.length, Math.max(half, POST_PURGE_SWEEP_BATCH - fresh.length));
  const recent = [...fresh.slice(0, POST_PURGE_SWEEP_BATCH - repeatTake), ...repeat.slice(0, repeatTake)];
  for (const { tenant_id: id } of recent) {
    try {
      await purgeTenantR2(env, id);
      await purgeTenantKv(env, id);
    } catch (error) {
      console.error("purge-sweep-failed", { tenant_id: id, error: String(error) });
    }
    await platformDb
      .prepare("UPDATE purge_sweeps SET swept_at = ? WHERE tenant_id = ?")
      .bind(now.toISOString(), id)
      .run()
      .catch((error) => console.error("purge-sweep-stamp-failed", { tenant_id: id, error: String(error) }));
  }
  return { staleProvisioning: Number(stale.meta?.changes ?? 0), completed, pending };
}

/** PRIV-4: the owner's removal request is honoured this long after it is made. */
export const REMOVAL_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The owner asks for the store to be removed: `purge_after` = now + 30 days,
 * audited. The store keeps working until then; the platform job starts the
 * purge once the date passes (src/platform/jobs.ts).
 */
export async function requestStoreRemoval(platformDb: D1Database, tenantId: string, actor: string, now = new Date()) {
  const purgeAfter = new Date(now.getTime() + REMOVAL_GRACE_MS).toISOString();
  const [updated] = await platformDb.batch([
    platformDb
      .prepare("UPDATE tenants SET purge_after = ? WHERE id = ? AND status = 'active' AND purge_after IS NULL")
      .bind(purgeAfter, tenantId),
    platformDb
      .prepare(
        `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
         SELECT id, 'removal_requested', ?, ?, json_object('purge_after', purge_after) FROM tenants WHERE id = ? AND purge_after = ?`,
      )
      .bind(actor, now.toISOString(), tenantId, purgeAfter),
  ]);
  return Number(updated.meta?.changes ?? 0) === 1 ? purgeAfter : null;
}

/** Cancel a pending removal while the date has not passed. */
export async function cancelStoreRemoval(platformDb: D1Database, tenantId: string, actor: string, now = new Date()) {
  const [updated] = await platformDb.batch([
    platformDb
      .prepare("UPDATE tenants SET purge_after = NULL WHERE id = ? AND status = 'active' AND purge_after > ?")
      .bind(tenantId, now.toISOString()),
    platformDb
      .prepare(
        `INSERT INTO tenant_events (tenant_id, kind, actor, at)
         SELECT id, 'removal_cancelled', ?, ? FROM tenants WHERE id = ? AND purge_after IS NULL AND status = 'active'`,
      )
      .bind(actor, now.toISOString(), tenantId),
  ]);
  return Number(updated.meta?.changes ?? 0) === 1;
}
