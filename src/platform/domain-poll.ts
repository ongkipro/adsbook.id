/**
 * A seller's own domain goes live without a second click (Paduka, 2026-11-16):
 * one store holds one domain, so once Cloudflare reports it active the store
 * makes it the primary itself — after the same HTTPS probe as the manual
 * "Jadikan domain utama" (DOM-4: only a host that serves this tenant becomes
 * primary). "Cek lagi" refreshes every host of the domain group at once
 * (`domain.com` and `www.domain.com` together), and the platform cron does the
 * same for pending domains, so a seller who points DNS and closes the tab still
 * gets the domain, its certificate and the 301s.
 */
import type { CustomHostnameApi, DomainResult, DomainView } from "./hostnames.ts";
import { refreshDomain, setPrimaryDomain } from "./hostnames.ts";

export type PromotionOutcome = "promoted" | "already-primary" | "not-ready" | "probe-failed";

type Member = { host: string; status: string; is_primary: number; domain_group: string };

async function groupMembers(platformDb: D1Database, tenantId: string, host: string): Promise<{ group: string; members: Member[] } | null> {
  const row = await platformDb
    .prepare("SELECT domain_group FROM tenant_hosts WHERE tenant_id = ? AND host = ? AND kind = 'custom' AND status != 'revoked'")
    .bind(tenantId, host.trim().toLowerCase().replace(/\.$/, ""))
    .first<{ domain_group: string | null }>();
  if (!row?.domain_group) return null;
  const members = (
    await platformDb
      .prepare(
        `SELECT host, status, is_primary, domain_group FROM tenant_hosts
         WHERE tenant_id = ? AND kind = 'custom' AND domain_group = ? AND status != 'revoked' ORDER BY host`,
      )
      .bind(tenantId, row.domain_group)
      .all<Member>()
  ).results;
  return { group: row.domain_group, members };
}

/**
 * The host of a group that should be the primary: the main domain when the
 * group has one (root mode, or a subdomain claim whose group is the host
 * itself), otherwise its `www` (www-only mode).
 */
export function canonicalMember(group: string, members: readonly { host: string }[]): string | null {
  if (members.some((member) => member.host === group)) return group;
  const www = `www.${group}`;
  return members.some((member) => member.host === www) ? www : null;
}

/** Refresh every host of the domain group `host` belongs to, in one call. */
export async function refreshDomainGroup(
  platformDb: D1Database,
  api: CustomHostnameApi,
  tenantId: string,
  host: string,
  options: { recheck?: boolean } = {},
): Promise<DomainResult<DomainView[]>> {
  const found = await groupMembers(platformDb, tenantId, host);
  if (!found) return { ok: false, status: 404, error: "Domain tidak ditemukan di toko ini." };
  const views: DomainView[] = [];
  let failure: DomainResult<DomainView[]> | null = null;
  for (const member of found.members) {
    const result = await refreshDomain(platformDb, api, tenantId, member.host, options);
    if (result.ok) views.push(result.value);
    else failure ??= { ok: false, status: result.status, error: result.error };
  }
  return views.length ? { ok: true, value: views } : (failure ?? { ok: false, status: 404, error: "Domain tidak ditemukan di toko ini." });
}

/**
 * Make the group's canonical host the primary once it is active and its HTTPS
 * probe answers this tenant. A failed probe changes nothing (the subdomain
 * stays primary and keeps serving); the next refresh tries again.
 */
export async function promoteGroupIfReady(
  platformDb: D1Database,
  tenantId: string,
  host: string,
  probe: (host: string) => Promise<boolean>,
): Promise<{ outcome: PromotionOutcome; host: string | null }> {
  const found = await groupMembers(platformDb, tenantId, host);
  if (!found) return { outcome: "not-ready", host: null };
  const target = canonicalMember(found.group, found.members);
  const member = found.members.find((candidate) => candidate.host === target);
  if (!target || !member || member.status !== "active") return { outcome: "not-ready", host: target };
  if (Number(member.is_primary) === 1) return { outcome: "already-primary", host: target };
  const promoted = await setPrimaryDomain(platformDb, tenantId, target, probe);
  return { outcome: promoted.ok ? "promoted" : "probe-failed", host: target };
}

export type PollDeps = {
  /** The tenant's own probe secret (its session key), or null when its store cannot be opened. */
  secretFor(tenantId: string): Promise<string | null>;
  probe(host: string, secret: string): Promise<boolean>;
  /** Called once per host that is active after the refresh. */
  onActive?(tenantId: string, slug: string, view: DomainView): void;
};

/**
 * The cron leg: up to `limit` domain groups that still have a pending host,
 * oldest first, are refreshed and, when active, promoted. Bounded per run; a
 * failure on one group never stops the others.
 */
export async function pollPendingDomains(
  platformDb: D1Database,
  api: CustomHostnameApi,
  deps: PollDeps,
  limit = 25,
): Promise<{ checked: number; activated: number; promoted: number }> {
  const groups = (
    await platformDb
      .prepare(
        `SELECT h.tenant_id, t.slug, h.domain_group AS grp, MIN(h.created_at) AS since
         FROM tenant_hosts h JOIN tenants t ON t.id = h.tenant_id
         WHERE h.kind = 'custom' AND h.status = 'pending' AND h.cf_custom_hostname_id IS NOT NULL
           AND h.domain_group IS NOT NULL AND t.status = 'active'
         GROUP BY h.tenant_id, h.domain_group ORDER BY since LIMIT ?`,
      )
      .bind(limit)
      .all<{ tenant_id: string; slug: string; grp: string; since: string }>()
  ).results;
  let activated = 0;
  let promoted = 0;
  for (const group of groups) {
    try {
      const anyHost = (
        await platformDb
          .prepare("SELECT host FROM tenant_hosts WHERE tenant_id = ? AND domain_group = ? AND kind = 'custom' AND status != 'revoked' LIMIT 1")
          .bind(group.tenant_id, group.grp)
          .first<{ host: string }>()
      )?.host;
      if (!anyHost) continue;
      const refreshed = await refreshDomainGroup(platformDb, api, group.tenant_id, anyHost);
      if (!refreshed.ok) continue;
      for (const view of refreshed.value) {
        if (view.status === "active") {
          activated += 1;
          deps.onActive?.(group.tenant_id, group.slug, view);
        }
      }
      const secret = await deps.secretFor(group.tenant_id);
      if (!secret) continue;
      const result = await promoteGroupIfReady(platformDb, group.tenant_id, anyHost, (host) => deps.probe(host, secret));
      if (result.outcome === "promoted") promoted += 1;
    } catch (error) {
      console.error("domain-poll-failed", { tenant_id: group.tenant_id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { checked: groups.length, activated, promoted };
}
