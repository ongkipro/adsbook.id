/**
 * UX-10 (T-52): the platform team — who can sign in to the console. Owner
 * only. Invariants: MFA is enrolled at creation (the secret is returned once),
 * a user never disables themselves, and at least one active platform_owner
 * always remains. Every change is audited in `tenant_events` under the
 * platform key `_platform` with actor, before and after (IAM-6).
 */
import { hashAdminPassword } from "../../lib/admin-credentials.ts";
import type { PlatformRole, PlatformUser } from "./session.ts";
import { newTotpSecret, otpauthUri } from "./totp.ts";

export const PLATFORM_EVENTS_TENANT = "_platform";
export const PLATFORM_ROLES: readonly PlatformRole[] = ["platform_owner", "platform_support"];

/** Console paths only a platform_owner reaches (the page renders 403, the API answers 403); read by the route map. */
export function isOwnerOnlyPlatformPath(pathname: string): boolean {
  return pathname === "/platform/team" || pathname === "/api/platform/team" || pathname.startsWith("/api/platform/team/");
}

export type TeamRow = {
  id: string;
  email: string;
  role: PlatformRole;
  mfa: number;
  disabled_at: string | null;
  created_at: string;
  last_sign_in: string | null;
};

export async function listTeam(platformDb: D1Database): Promise<TeamRow[]> {
  return (
    await platformDb
      .prepare(
        `SELECT u.id, u.email, u.role, CASE WHEN u.totp_secret IS NULL THEN 0 ELSE 1 END AS mfa, u.disabled_at, u.created_at,
           (SELECT MAX(s.created_at) FROM platform_sessions s WHERE s.user_id = u.id) AS last_sign_in
         FROM platform_users u ORDER BY u.disabled_at IS NOT NULL, u.created_at`,
      )
      .all<TeamRow>()
  ).results;
}

export type TeamResult<T = undefined> = { ok: true; message: string; value?: T } | { ok: false; status: number; error: string };

const audit = (platformDb: D1Database, kind: string, actor: PlatformUser, now: Date, detail: Record<string, unknown>) =>
  platformDb
    .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, ?, ?, ?, ?)")
    .bind(PLATFORM_EVENTS_TENANT, kind, `platform:${actor.id}`, now.toISOString(), JSON.stringify(detail));

const ownerOnly = (actor: PlatformUser): TeamResult | null =>
  actor.role === "platform_owner" ? null : { ok: false, status: 403, error: "Hanya owner platform yang boleh mengelola tim." };

/** Adds a user with MFA enrolled; the TOTP secret is in the result once and never readable again. */
export async function addTeamMember(
  platformDb: D1Database,
  actor: PlatformUser,
  input: { email?: unknown; role?: unknown; password?: unknown },
  now = new Date(),
): Promise<TeamResult<{ id: string; email: string; totpSecret: string; otpauthUri: string }>> {
  const refused = ownerOnly(actor);
  if (refused) return refused;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const role = input.role as PlatformRole;
  const password = typeof input.password === "string" ? input.password : "";
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return { ok: false, status: 422, error: "Email tidak valid." };
  if (!PLATFORM_ROLES.includes(role)) return { ok: false, status: 422, error: "Peran tidak dikenal." };
  if (password.length < 12 || password.length > 128) return { ok: false, status: 422, error: "Password awal 12–128 karakter." };
  const exists = await platformDb.prepare("SELECT 1 AS yes FROM platform_users WHERE email = ?").bind(email).first();
  if (exists) return { ok: false, status: 409, error: "Email ini sudah terdaftar di tim." };
  const id = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const secret = newTotpSecret();
  try {
    await platformDb.batch([
      platformDb
        .prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, email, await hashAdminPassword(password), secret, role, now.toISOString()),
      audit(platformDb, "platform_user_added", actor, now, { user: id, email, role, before: null, after: "active" }),
    ]);
  } catch {
    return { ok: false, status: 409, error: "Email ini sudah terdaftar di tim." };
  }
  return { ok: true, message: `${email} ditambahkan sebagai ${role === "platform_owner" ? "owner" : "support"}.`, value: { id, email, totpSecret: secret, otpauthUri: otpauthUri(secret, email) } };
}

/** Disables or re-enables a user; disabling revokes their sessions in the same batch. */
export async function setTeamMemberDisabled(
  platformDb: D1Database,
  actor: PlatformUser,
  userId: string,
  disabled: boolean,
  now = new Date(),
): Promise<TeamResult> {
  const refused = ownerOnly(actor);
  if (refused) return refused;
  const target = await platformDb
    .prepare("SELECT id, email, role, disabled_at FROM platform_users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string; role: PlatformRole; disabled_at: string | null }>();
  if (!target) return { ok: false, status: 404, error: "Pengguna tidak ditemukan." };
  const at = now.toISOString();
  if (!disabled) {
    if (!target.disabled_at) return { ok: false, status: 409, error: "Pengguna sudah aktif." };
    const [changed] = await platformDb.batch([
      platformDb.prepare("UPDATE platform_users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL").bind(userId),
      platformDb
        .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'platform_user_enabled', ?, ?, ? WHERE changes() = 1")
        .bind(PLATFORM_EVENTS_TENANT, `platform:${actor.id}`, at, JSON.stringify({ user: userId, email: target.email, before: "disabled", after: "active" })),
    ]);
    return Number(changed.meta?.changes ?? 0) === 1 ? { ok: true, message: `${target.email} aktif kembali.` } : { ok: false, status: 409, error: "Pengguna sudah aktif." };
  }
  if (userId === actor.id) return { ok: false, status: 409, error: "Anda tidak bisa menonaktifkan akun sendiri." };
  if (target.disabled_at) return { ok: false, status: 409, error: "Pengguna sudah nonaktif." };
  // The last-owner rule is in the UPDATE itself, so two owners disabling each
  // other at once cannot both succeed.
  const [changed] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE platform_users SET disabled_at = ?1 WHERE id = ?2 AND disabled_at IS NULL
           AND (role <> 'platform_owner' OR (SELECT COUNT(*) FROM platform_users WHERE role = 'platform_owner' AND disabled_at IS NULL AND id <> ?2) >= 1)`,
      )
      .bind(at, userId),
    platformDb
      .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'platform_user_disabled', ?, ?, ? WHERE changes() = 1")
      .bind(PLATFORM_EVENTS_TENANT, `platform:${actor.id}`, at, JSON.stringify({ user: userId, email: target.email, role: target.role, before: "active", after: "disabled" })),
    platformDb.prepare("UPDATE platform_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM platform_users WHERE id = ?2 AND disabled_at = ?1)").bind(at, userId),
  ]);
  if (Number(changed.meta?.changes ?? 0) !== 1) return { ok: false, status: 409, error: "Harus tersisa minimal satu owner platform yang aktif." };
  return { ok: true, message: `${target.email} dinonaktifkan; sesinya ditutup.` };
}
