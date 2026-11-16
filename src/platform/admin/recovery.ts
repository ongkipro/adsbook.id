/**
 * IAM-9 on the seller host: the owner redeems the `owner_recovery` token a
 * platform_owner issued after out-of-band verification, and sets a new
 * password here. Every tenant session is revoked. The platform never sees,
 * sets or reads the password; the redemption is audited.
 */
import { hashAdminPassword } from "../../lib/admin-credentials.ts";
import { handoffIssuanceId, peekHandoff, spendHandoff } from "../handoff.ts";

export type RecoveryResult = { ok: true } | { ok: false; status: 400 | 401 | 500; error: string };

const REFUSED = { ok: false as const, status: 401 as const, error: "Tautan pemulihan tidak berlaku." };

/**
 * Order (T-27 review, final): everything refusable is checked before the
 * token is touched (peeked, not spent), so a typo never costs the owner the
 * code. Then the token is spent atomically together with its
 * `owner_recovery_redeemed` event (linked to the issuance) — this is the fence:
 * of any number of attempts, exactly one gets past it, and only that one
 * writes the tenant. The tenant writes are one batch (the session purge only
 * if the owner row changed). If they fail after the spend, the failure is
 * audited and the owner asks for a new code: availability is given up so that
 * a code can never change the password twice.
 */
export async function redeemOwnerRecovery(
  platformDb: D1Database,
  tenantDb: D1Database,
  tenant: { tenantId: string; host: string; hostKind: string },
  token: unknown,
  password: unknown,
  now = new Date(),
): Promise<RecoveryResult> {
  if (tenant.hostKind !== "subdomain") return REFUSED;
  if ((await peekHandoff(platformDb, token, tenant.host, "owner_recovery", now)) !== tenant.tenantId) return REFUSED;
  const owner = await platformDb.prepare("SELECT owner_email FROM tenants WHERE id = ? AND status = 'active'").bind(tenant.tenantId).first<{ owner_email: string }>();
  if (!owner) return REFUSED;
  const next = typeof password === "string" ? password : "";
  if (next.length < 10 || next.length > 128) return { ok: false, status: 400, error: "Password baru 10–128 karakter." };
  if (next.toLowerCase() === owner.owner_email) return { ok: false, status: 400, error: "Password tidak boleh sama dengan email." };
  const passwordHash = await hashAdminPassword(next);
  const tokenText = String(token);
  const issuance = await handoffIssuanceId(tokenText);

  // The fence: spend and audit together; only the attempt that spends goes on.
  const [spent] = await platformDb.batch([
    await spendHandoff(platformDb, tokenText, tenant.host, "owner_recovery", now),
    platformDb
      .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'owner_recovery_redeemed', ?, ?, ? WHERE changes() = 1")
      .bind(tenant.tenantId, `owner:${owner.owner_email}`, now.toISOString(), JSON.stringify({ issuance, outcome: "pending" })),
  ]);
  if (Number(spent.meta?.changes ?? 0) !== 1) return REFUSED;

  // The outcome row. If even this write fails, the `pending` redemption stays
  // unresolved and the platform health page lists it for an operator.
  const outcome = async (kind: "owner_recovery_completed" | "owner_recovery_failed", detail: Record<string, unknown>) => {
    await platformDb
      .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, ?, 'platform', ?, ?)")
      .bind(tenant.tenantId, kind, now.toISOString(), JSON.stringify({ issuance, ...detail }))
      .run()
      .catch((error) => console.error("owner-recovery-outcome-unrecorded", { tenant_id: tenant.tenantId, issuance, kind, error: String(error) }));
  };
  const failed = async (reason: string) => {
    await outcome("owner_recovery_failed", { reason });
    return { ok: false as const, status: 500 as const, error: "Pemulihan gagal. Minta kode pemulihan baru ke tim adsbook.id." };
  };
  try {
    const [updated] = await tenantDb.batch([
      tenantDb
        .prepare(
          `UPDATE admin_credentials SET password_hash = ?1, must_change_password = 0, updated_at = ?2
           WHERE id = (SELECT id FROM admin_credentials WHERE role = 'owner' AND (username = ?3 OR email = ?3) ORDER BY id LIMIT 1)`,
        )
        .bind(passwordHash, now.toISOString(), owner.owner_email),
      // Only when the owner's password really changed.
      tenantDb.prepare("DELETE FROM admin_sessions WHERE changes() = 1"),
    ]);
    if (Number(updated.meta?.changes ?? 0) !== 1) return failed("owner_missing");
  } catch (error) {
    console.error("owner-recovery-tenant-write-failed", { tenant_id: tenant.tenantId, error: String(error) });
    return failed("tenant_write_failed");
  }
  await outcome("owner_recovery_completed", {});
  return { ok: true };
}
