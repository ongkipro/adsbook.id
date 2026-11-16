/**
 * Plan guardrails (T-37, PR-22, BILL-1/2): every limit comes from the
 * tenant's plan row in `PLATFORM_DB.plans`, never from a constant, so a plan
 * change moves it at once. v1 has the `pilot` plan only; nothing here charges.
 *
 * Hourly caps are counted per tenant in the control plane's `rate_limits`
 * (key `<cap>:<tenantId>`), not per address: one tenant's staff on several
 * networks share one allowance, and two tenants never share one. Daily usage
 * lands in `tenant_usage_daily`, one row per tenant per day.
 */

export type PlanLimits = {
  planId: string;
  maxCustomDomains: number;
  mediaUploadsPerHour: number;
  aiGenerationsPerHour: number;
};

export async function tenantPlan(platformDb: D1Database, tenantId: string): Promise<PlanLimits | null> {
  const row = await platformDb
    .prepare(
      `SELECT p.id, p.max_custom_domains, p.media_uploads_per_hour, p.ai_generations_per_hour
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?`,
    )
    .bind(tenantId)
    .first<{ id: string; max_custom_domains: number; media_uploads_per_hour: number; ai_generations_per_hour: number }>();
  return row
    ? {
        planId: row.id,
        maxCustomDomains: Number(row.max_custom_domains),
        mediaUploadsPerHour: Number(row.media_uploads_per_hour),
        aiGenerationsPerHour: Number(row.ai_generations_per_hour),
      }
    : null;
}

/**
 * `media-derivative` is the card-sized twin of an upload (`-sm`): counted on
 * its own allowance of the same size as the media cap, so a twin never eats
 * an upload and the twins can never outrun the plan either.
 */
const HOUR_MS = 60 * 60 * 1000;

export type PlanCap = "media" | "media-derivative" | "ai";

export type CapCheck = { allowed: true; limit: number } | { allowed: false; limit: number; error: string };

/**
 * Check (and, with `consume`, spend) one unit of an hourly cap. A tenant with
 * no plan row is refused: an unknown plan grants nothing. Unlike the shared
 * `checkRateLimit` (which fails open so a store error never locks out a
 * login), a store error here throws: a cap must never open on a failure.
 */
export async function checkPlanCap(
  platformDb: D1Database | undefined,
  tenantId: string | undefined,
  cap: PlanCap,
  consume: boolean,
): Promise<CapCheck> {
  if (!platformDb || !tenantId) return { allowed: false, limit: 0, error: "Batas paket belum tersedia." };
  const plan = await tenantPlan(platformDb, tenantId);
  const limit = !plan ? 0 : cap === "ai" ? plan.aiGenerationsPerHour : plan.mediaUploadsPerHour;
  if (limit <= 0) return { allowed: false, limit, error: "Fitur ini tidak termasuk paket Anda." };
  const windowStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const key = `${cap}:${tenantId}:${windowStart}`;
  // Spend: one conditional upsert; a full window writes nothing and returns no row.
  const allowed = consume
    ? Boolean(
        await platformDb
          .prepare(
            `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
             ON CONFLICT (key) DO UPDATE SET count = count + 1 WHERE count < ?3
             RETURNING count`,
          )
          .bind(key, windowStart + HOUR_MS, limit)
          .first(),
      )
    : Number((await platformDb.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first<{ count: number }>())?.count ?? 0) < limit;
  if (allowed) return { allowed: true, limit };
  return {
    allowed: false,
    limit,
    error: cap === "ai" ? `Batas paket: ${limit} pembuatan konten AI per jam.` : `Batas paket: ${limit} upload per jam.`,
  };
}

/** The UTC day a usage row belongs to. */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Add to today's usage row for the tenant (created on first use; one row per tenant per day). */
export async function recordUsage(
  platformDb: D1Database,
  tenantId: string,
  delta: { orders?: number; requests?: number; mediaBytes?: number },
  now = new Date(),
): Promise<void> {
  // PR-26: the demo store's usage is never counted.
  await platformDb
    .prepare(
      `INSERT INTO tenant_usage_daily (tenant_id, day, orders, requests, media_bytes, custom_hostnames)
       SELECT ?1, ?2, ?3, ?4, ?5, (SELECT COUNT(*) FROM tenant_hosts WHERE tenant_id = ?1 AND kind = 'custom' AND status != 'revoked')
       WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = ?1 AND is_demo = 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET
         orders = orders + excluded.orders,
         requests = requests + excluded.requests,
         media_bytes = media_bytes + excluded.media_bytes,
         custom_hostnames = excluded.custom_hostnames`,
    )
    .bind(tenantId, usageDay(now), delta.orders ?? 0, delta.requests ?? 0, delta.mediaBytes ?? 0)
    .run();
}
