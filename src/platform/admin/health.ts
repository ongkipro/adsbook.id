/**
 * The platform health page (OBS-3, OBS-4): what the control plane knows,
 * on one page — tenants by status, stale heartbeats (> 2 h) and growing
 * backlogs, tenants in recovery, custom-hostname states. Worker error rate
 * and gate 404/503 counts come from Workers Logs and the Cloudflare
 * dashboard's analytics, linked from the page; the request log line (OBS-1)
 * carries host kind, status and reason for those queries.
 */
import { STALE_HEARTBEAT_MS } from "./tenants.ts";

export async function platformHealth(platformDb: D1Database, now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_HEARTBEAT_MS).toISOString();
  const unresolvedBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const [statuses, stale, recovery, hostnames, backlog, unresolved] = await Promise.all([
    platformDb.prepare("SELECT status, COUNT(*) AS n FROM tenants GROUP BY status ORDER BY status").all<{ status: string; n: number }>(),
    platformDb
      .prepare(
        `SELECT t.id, t.slug, h.heartbeat_at, h.last_error FROM tenants t LEFT JOIN tenant_health h ON h.tenant_id = t.id
         WHERE t.status = 'active' AND (h.heartbeat_at IS NULL OR h.heartbeat_at < ?) ORDER BY h.heartbeat_at LIMIT 100`,
      )
      .bind(staleBefore)
      .all<{ id: string; slug: string; heartbeat_at: string | null; last_error: string | null }>(),
    platformDb.prepare("SELECT id, slug FROM tenants WHERE status = 'recovery' ORDER BY slug").all<{ id: string; slug: string }>(),
    platformDb
      .prepare("SELECT status, COUNT(*) AS n FROM tenant_hosts WHERE kind = 'custom' GROUP BY status ORDER BY status")
      .all<{ status: string; n: number }>(),
    platformDb
      .prepare(
        `SELECT t.id, t.slug, h.outbox_backlog FROM tenants t JOIN tenant_health h ON h.tenant_id = t.id
         WHERE h.outbox_backlog > 0 ORDER BY h.outbox_backlog DESC LIMIT 20`,
      )
      .all<{ id: string; slug: string; outbox_backlog: number }>(),
    // IAM-9: every spent recovery code with no recorded outcome after 5 minutes,
    // oldest first and uncapped — each one needs an operator.
    platformDb
      .prepare(
        `SELECT r.tenant_id, t.slug, r.at, json_extract(r.detail_json, '$.issuance') AS issuance
         FROM tenant_events r LEFT JOIN tenants t ON t.id = r.tenant_id
         WHERE r.kind = 'owner_recovery_redeemed' AND r.at < ?
           AND NOT EXISTS (SELECT 1 FROM tenant_events o
             WHERE o.tenant_id = r.tenant_id AND o.kind IN ('owner_recovery_completed', 'owner_recovery_failed')
               AND json_extract(o.detail_json, '$.issuance') = json_extract(r.detail_json, '$.issuance'))
         ORDER BY r.at`,
      )
      .bind(unresolvedBefore)
      .all<{ tenant_id: string; slug: string | null; at: string; issuance: string }>(),
  ]);
  return {
    checkedAt: now.toISOString(),
    statuses: statuses.results,
    staleHeartbeats: stale.results,
    recovery: recovery.results,
    customHostnames: hostnames.results,
    backlog: backlog.results,
    unresolvedRecoveries: unresolved.results,
  };
}
