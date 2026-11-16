/**
 * Platform admin's view of tenants and its actions (UX-4, API-6, TEN-6).
 * It reads only the control plane — never a tenant's orders, customers,
 * catalogue or credentials — and every action writes `tenant_events` with the
 * operator id, before and after (IAM-6).
 *
 * Role matrix (spec 07): platform_support lists, views health, suspends and
 * resumes; plan change, purge request and owner recovery are platform_owner
 * only (AUTHZ-3).
 */
import { prepareHandoff } from "../handoff.ts";
import { grantSubscription } from "../billing.ts";
import { REMOVAL_GRACE_MS } from "../purge.ts";
import type { PlatformRole, PlatformUser } from "./session.ts";

export type TenantAction = "suspend" | "resume" | "plan" | "purge-request" | "recover" | "grant-subscription";

export const ACTION_ROLES: Record<TenantAction, readonly PlatformRole[]> = {
  suspend: ["platform_owner", "platform_support"],
  resume: ["platform_owner", "platform_support"],
  plan: ["platform_owner"],
  "purge-request": ["platform_owner"],
  recover: ["platform_owner"],
  // BILL-7 (ADR-041): free subscription days are money; the owner role only.
  "grant-subscription": ["platform_owner"],
};

/** A heartbeat older than this is stale (OBS-3). */
export const STALE_HEARTBEAT_MS = 2 * 60 * 60 * 1000;

export type TenantListRow = {
  id: string;
  slug: string;
  status: string;
  plan_id: string;
  created_at: string;
  primary_host: string | null;
  last_activity: string | null;
  heartbeat_at: string | null;
  outbox_backlog: number | null;
  purge_after: string | null;
};

export async function listTenants(
  platformDb: D1Database,
  filter: { status?: string | null; search?: string | null } = {},
): Promise<TenantListRow[]> {
  const status = filter.status && /^[a-z]+$/.test(filter.status) ? filter.status : null;
  const search = filter.search?.trim().toLowerCase().slice(0, 100) || null;
  return (
    await platformDb
      .prepare(
        `SELECT t.id, t.slug, t.status, t.plan_id, t.created_at, t.purge_after,
           (SELECT host FROM tenant_hosts p WHERE p.tenant_id = t.id AND p.is_primary = 1) AS primary_host,
           (SELECT MAX(at) FROM tenant_events e WHERE e.tenant_id = t.id) AS last_activity,
           h.heartbeat_at, h.outbox_backlog
         FROM tenants t LEFT JOIN tenant_health h ON h.tenant_id = t.id
         WHERE (?1 IS NULL OR t.status = ?1)
           AND (?2 IS NULL OR t.slug LIKE '%' || ?2 || '%'
                OR EXISTS (SELECT 1 FROM tenant_hosts x WHERE x.tenant_id = t.id AND x.host LIKE '%' || ?2 || '%'))
         ORDER BY t.created_at DESC LIMIT 200`,
      )
      .bind(status, search)
      .all<TenantListRow>()
  ).results;
}

export async function tenantDetail(platformDb: D1Database, tenantId: string) {
  const tenant = await platformDb
    .prepare("SELECT id, slug, owner_email, owner_whatsapp, status, plan_id, cache_version, schema_version, purge_after, subscription_ends_at, grace_ends_at, is_demo, created_at FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<Record<string, unknown>>();
  if (!tenant) return null;
  const [hosts, events, health] = await Promise.all([
    platformDb
      .prepare("SELECT host, kind, status, ssl_status, is_primary, created_at FROM tenant_hosts WHERE tenant_id = ? ORDER BY is_primary DESC, host")
      .bind(tenantId)
      .all(),
    platformDb
      .prepare("SELECT kind, actor, at, detail_json FROM tenant_events WHERE tenant_id = ? ORDER BY id DESC LIMIT 50")
      .bind(tenantId)
      .all(),
    platformDb.prepare("SELECT heartbeat_at, outbox_backlog, last_error FROM tenant_health WHERE tenant_id = ?").bind(tenantId).first(),
  ]);
  return { tenant, hosts: hosts.results, events: events.results, health };
}

export type ActionResult = { ok: true; message: string; recoveryToken?: string } | { ok: false; status: number; error: string };

function audit(platformDb: D1Database, tenantId: string, kind: string, actor: PlatformUser, now: Date, detail: Record<string, unknown>) {
  return platformDb
    .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, ?, ?, ?, ?)")
    .bind(tenantId, kind, `platform:${actor.id}`, now.toISOString(), JSON.stringify(detail));
}

/** One audited platform action. The role is checked here as well as in the route. */
export async function runTenantAction(
  platformDb: D1Database,
  actor: PlatformUser,
  tenantId: string,
  action: TenantAction,
  input: { reason?: unknown; plan?: unknown; slug?: unknown; evidence?: unknown; days?: unknown },
  now = new Date(),
): Promise<ActionResult> {
  if (!ACTION_ROLES[action]?.includes(actor.role)) return { ok: false, status: 403, error: "Peran Anda tidak boleh melakukan aksi ini." };
  const tenant = await platformDb
    .prepare("SELECT id, slug, status, plan_id, purge_after FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<{ id: string; slug: string; status: string; plan_id: string; purge_after: string | null }>();
  if (!tenant) return { ok: false, status: 404, error: "Tenant tidak ditemukan." };
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

  /** The audit row of the statement just before it, written only if that statement changed one row. */
  const auditIfChanged = (kind: string, detail: Record<string, unknown>) =>
    platformDb
      .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
      .bind(tenantId, kind, `platform:${actor.id}`, now.toISOString(), JSON.stringify(detail));

  const transition = async (from: string, to: string, kind: string, detail: Record<string, unknown>) => {
    // The state change and its audit row together, the row only if the state
    // really changed; the cache version moves so nothing cached under the old
    // state is served again.
    const [changed] = await platformDb.batch([
      platformDb
        .prepare("UPDATE tenants SET status = ?, cache_version = cache_version + 1 WHERE id = ? AND status = ?")
        .bind(to, tenantId, from),
      auditIfChanged(kind, { ...detail, before: from, after: to }),
    ]);
    return Number(changed.meta?.changes ?? 0) === 1;
  };

  switch (action) {
    case "grant-subscription": {
      const granted = await grantSubscription(platformDb, { tenantId, days: input.days, reason: input.reason, actor: `platform:${actor.id}` }, now);
      return granted.ok
        ? { ok: true, message: `Langganan ${tenant.slug} aktif sampai ${granted.value.subscriptionEndsAt.slice(0, 10)}.` }
        : { ok: false, status: granted.status, error: granted.error };
    }
    case "suspend": {
      const reason = text(input.reason, 500);
      if (reason.length < 3) return { ok: false, status: 400, error: "Alasan wajib diisi." };
      return (await transition("active", "suspended", "suspended", { reason }))
        ? { ok: true, message: `Toko ${tenant.slug} ditangguhkan.` }
        : { ok: false, status: 409, error: "Hanya toko aktif yang bisa ditangguhkan." };
    }
    case "resume": {
      const reason = text(input.reason, 500);
      if (reason.length < 3) return { ok: false, status: 400, error: "Alasan wajib diisi." };
      return (await transition("suspended", "active", "resumed", { reason }))
        ? { ok: true, message: `Toko ${tenant.slug} aktif kembali.` }
        : { ok: false, status: 409, error: "Hanya toko yang ditangguhkan yang bisa diaktifkan kembali." };
    }
    case "plan": {
      const plan = text(input.plan, 40);
      const exists = await platformDb.prepare("SELECT 1 AS yes FROM plans WHERE id = ?").bind(plan).first();
      if (!exists) return { ok: false, status: 400, error: "Paket tidak dikenal." };
      // Conditioned on the plan read above: a concurrent change makes this a 409, never a stale `before`.
      const [changed] = await platformDb.batch([
        platformDb.prepare("UPDATE tenants SET plan_id = ? WHERE id = ? AND plan_id = ?").bind(plan, tenantId, tenant.plan_id),
        auditIfChanged("plan_changed", { before: tenant.plan_id, after: plan }),
      ]);
      return Number(changed.meta?.changes ?? 0) === 1
        ? { ok: true, message: `Paket ${tenant.slug} menjadi ${plan}.` }
        : { ok: false, status: 409, error: "Paket berubah di sesi lain. Muat ulang halaman." };
    }
    case "purge-request": {
      if (text(input.slug, 64) !== tenant.slug) return { ok: false, status: 400, error: "Ketik alamat toko persis untuk mengonfirmasi." };
      if (tenant.status === "purging" || tenant.status === "purged") return { ok: false, status: 409, error: "Toko sudah dihapus." };
      const purgeAfter = new Date(now.getTime() + REMOVAL_GRACE_MS).toISOString();
      const [changed] = await platformDb.batch([
        platformDb
          .prepare("UPDATE tenants SET purge_after = ? WHERE id = ? AND purge_after IS NULL AND status NOT IN ('purging', 'purged')")
          .bind(purgeAfter, tenantId),
        auditIfChanged("purge_requested", { before: null, after: purgeAfter }),
      ]);
      return Number(changed.meta?.changes ?? 0) === 1
        ? { ok: true, message: `Toko ${tenant.slug} dihapus permanen setelah ${purgeAfter.slice(0, 10)} (30 hari).` }
        : { ok: false, status: 409, error: "Penghapusan sudah dijadwalkan." };
    }
    case "recover": {
      // IAM-9: the operator records the out-of-band verification and gets a
      // one-time token for the owner, who sets the password on the seller host.
      const evidence = text(input.evidence, 500);
      if (evidence.length < 10) return { ok: false, status: 400, error: "Catat ringkasan verifikasi (tanpa salinan dokumen)." };
      if (tenant.status !== "active") return { ok: false, status: 409, error: "Pemulihan hanya untuk toko aktif." };
      const host = await platformDb
        .prepare("SELECT host FROM tenant_hosts WHERE tenant_id = ? AND kind = 'subdomain' AND status = 'active'")
        .bind(tenantId)
        .first<{ host: string }>();
      if (!host) return { ok: false, status: 409, error: "Subdomain toko belum aktif." };
      // The token and its audit row in one batch: no token exists without its
      // operator event. The event names a non-secret issuance id, never the token.
      const handoff = await prepareHandoff(platformDb, tenantId, host.host, "owner_recovery", now);
      await platformDb.batch([
        handoff.statement,
        audit(platformDb, tenantId, "owner_recovery", actor, now, {
          evidence,
          host: host.host,
          issuance: handoff.issuance,
          before: { recovery_token: null },
          after: { recovery_token: handoff.issuance, expires_at: handoff.expiresAt },
        }),
      ]);
      const token = handoff.token;
      return { ok: true, message: `Token pemulihan untuk ${host.host} berlaku 24 jam.`, recoveryToken: token };
    }
    default:
      return { ok: false, status: 400, error: "Aksi tidak dikenal." };
  }
}
