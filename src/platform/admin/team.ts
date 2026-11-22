/**
 * UX-10 (T-52): the platform team — who can sign in to the console. Owner
 * only. Invariants: a member is created without password or TOTP and enrolls
 * through a single-use link (IAM-11, `credentials.ts`); no factor is ever
 * shown to the owner; a user never disables themselves, and at least one
 * active, enrolled platform_owner always remains. Every change is audited in `tenant_events` under the
 * platform key `_platform` with actor, before and after (IAM-6).
 */
import { activeOwner, bornDead, GRANT_PAGE, grantStatements, issueCredentialGrant, type LinkGate, liveSession, NOT_ENROLLED_HASH, PLATFORM_EVENTS_TENANT, revokeIssuedGrants, revokeOpenGrants, stepUp } from "./credentials.ts";
import type { PlatformRole, PlatformUser } from "./session.ts";

export { PLATFORM_EVENTS_TENANT };
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

const ownerOnly = (actor: PlatformUser): TeamResult | null =>
  actor.role === "platform_owner" ? null : { ok: false, status: 403, error: "Hanya owner platform yang boleh mengelola tim." };

/**
 * Adds a member, not yet enrolled, behind the owner's step-up code, and issues
 * their enrollment link: the owner passes it on through a verified channel and
 * the member sets their own password and authenticator. No factor of theirs is
 * ever shown to the owner.
 *
 * One batch, all or nothing: the member row and its grant are both fenced on
 * the actor still being an active, enrolled owner at the write, and the
 * grant on the member being pending — so a refused or failed add leaves no
 * pending row without a grant, no grant, and no audit row. Recovery is by
 * design manual and safe: a step-up code that passed is spent even when the
 * write is then refused, and the owner retries with the next code; a member
 * whose link expired gets "Tautan aktivasi baru" or is disabled.
 */
export async function addTeamMember(
  platformDb: D1Database,
  actor: PlatformUser,
  input: { email?: unknown; role?: unknown; totp?: unknown },
  origin: string,
  links: LinkGate,
  now = new Date(),
): Promise<TeamResult<{ id: string; email: string; link: string; expiresAt: string }>> {
  const refused = ownerOnly(actor);
  if (refused) return refused;
  if (!actor.sessionId) return { ok: false, status: 401, error: "Sesi tidak berlaku. Masuk lagi." };
  // A member is created only with an enrollment link: with links off, nobody is added.
  const closed = { ok: false as const, status: 503, error: "Tautan akses sedang dinonaktifkan; anggota baru belum bisa ditambahkan." };
  if (!links().open) return closed;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const role = input.role as PlatformRole;
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return { ok: false, status: 422, error: "Email tidak valid." };
  if (!PLATFORM_ROLES.includes(role)) return { ok: false, status: 422, error: "Peran tidak dikenal." };
  const exists = await platformDb.prepare("SELECT 1 AS yes FROM platform_users WHERE email = ?").bind(email).first();
  if (exists) return { ok: false, status: 409, error: "Email ini sudah terdaftar di tim." };
  const stepped = await stepUp(platformDb, actor, input.totp, now);
  if (!stepped.ok) return stepped;
  const id = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  // One authorization decision: the member insert. The grant follows its result.
  const grant = await grantStatements(platformDb, actor, { id, email }, "enrollment", now, true);
  const [grantInsert, ...grantFollowUps] = grant.statements;
  if (bornDead(links(), now)) return closed; // re-read at commit: links off, or a cutoff would kill this link
  let results: D1Result[];
  try {
    results = await platformDb.batch([
      platformDb
        .prepare(
          `INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) SELECT ?1, ?2, ?3, NULL, ?4, ?5
           WHERE ${activeOwner("?6")} AND ${liveSession("?7", "?6")}`,
        )
        .bind(id, email, NOT_ENROLLED_HASH, role, now.toISOString(), actor.id, actor.sessionId),
      grantInsert,
      platformDb
        .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'platform_user_added', ?, ?, ? WHERE EXISTS (SELECT 1 FROM platform_credential_grants WHERE user_id = ?)")
        .bind(PLATFORM_EVENTS_TENANT, `platform:${actor.id}`, now.toISOString(), JSON.stringify({ user: id, email, role, before: null, after: "pending" }), id),
      ...grantFollowUps,
    ]);
  } catch {
    // The batch is one transaction: nothing of it was written. Name the duplicate only if it is one.
    const taken = await platformDb.prepare("SELECT 1 AS yes FROM platform_users WHERE email = ?").bind(email).first().catch(() => null);
    return taken ? { ok: false, status: 409, error: "Email ini sudah terdaftar di tim." } : { ok: false, status: 503, error: "Gagal menyimpan. Tidak ada yang berubah; coba lagi dengan kode berikutnya." };
  }
  if (Number(results[0].meta?.changes ?? 0) !== 1) return { ok: false, status: 403, error: "Sesi atau akses owner Anda berubah. Masuk lagi." };
  return {
    ok: true,
    message: `${email} ditambahkan sebagai ${role === "platform_owner" ? "owner" : "support"}; aktif setelah tautan aktivasi dipakai.`,
    value: { id, email, link: `${origin}${GRANT_PAGE}#${grant.token}`, expiresAt: grant.expiresAt },
  };
}

/**
 * The one access action on another member: a password-reset link for an
 * enrolled support member, or a fresh enrollment link for a member who has not
 * enrolled yet. Never both factors, never an owner's password (break-glass).
 */
export async function issueTeamMemberLink(
  platformDb: D1Database,
  actor: PlatformUser,
  userId: string,
  totp: unknown,
  origin: string,
  links: LinkGate,
  now = new Date(),
): Promise<TeamResult<{ email: string; link: string; expiresAt: string; purpose: "password_reset" | "enrollment" }>> {
  const refused = ownerOnly(actor);
  if (refused) return refused;
  const target = await platformDb.prepare("SELECT totp_secret IS NOT NULL AS enrolled FROM platform_users WHERE id = ?").bind(userId).first<{ enrolled: number }>();
  if (!target) return { ok: false, status: 404, error: "Pengguna tidak ditemukan." };
  const purpose = target.enrolled ? "password_reset" : "enrollment";
  const grant = await issueCredentialGrant(platformDb, actor, userId, purpose, totp, origin, links, now);
  if (!grant.ok) return grant;
  return { ok: true, message: grant.message, value: { ...grant.value!, purpose } };
}

/** Refused when the batch's first statement changed nothing: the actor's authority or session is gone, or the target moved. */
const NOT_SAVED = { ok: false as const, status: 409, error: "Tidak tersimpan: sesi atau peran Anda berubah, status pengguna ini berubah, atau harus tersisa minimal satu owner aktif. Muat ulang halaman." };
const NO_SESSION = { ok: false as const, status: 401, error: "Sesi tidak berlaku. Masuk lagi." };

/**
 * Disables or re-enables a user. The first statement of the batch is the only
 * one that decides: it changes the target only while the actor is still an
 * active, enrolled platform_owner with a live session (database clock), and
 * every side effect — the audit row, the session and grant revocations — runs
 * only if that statement changed the row.
 */
export async function setTeamMemberDisabled(
  platformDb: D1Database,
  actor: PlatformUser,
  userId: string,
  disabled: boolean,
  now = new Date(),
): Promise<TeamResult> {
  const refused = ownerOnly(actor);
  if (refused) return refused;
  if (!actor.sessionId) return NO_SESSION;
  const target = await platformDb
    .prepare("SELECT id, email, role, disabled_at, credential_generation FROM platform_users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string; role: PlatformRole; disabled_at: string | null; credential_generation: number }>();
  if (!target) return { ok: false, status: 404, error: "Pengguna tidak ditemukan." };
  const at = now.toISOString();
  if (!disabled) {
    if (!target.disabled_at) return { ok: false, status: 409, error: "Pengguna sudah aktif." };
    const [changed] = await platformDb.batch([
      platformDb
        .prepare(`UPDATE platform_users SET disabled_at = NULL WHERE id = ?1 AND disabled_at IS NOT NULL AND ${activeOwner("?2")} AND ${liveSession("?3", "?2")}`)
        .bind(userId, actor.id, actor.sessionId),
      platformDb
        .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'platform_user_enabled', ?, ?, ? WHERE changes() = 1")
        .bind(PLATFORM_EVENTS_TENANT, `platform:${actor.id}`, at, JSON.stringify({ user: userId, email: target.email, before: "disabled", after: "active" })),
    ]);
    return Number(changed.meta?.changes ?? 0) === 1 ? { ok: true, message: `${target.email} aktif kembali.` } : NOT_SAVED;
  }
  if (userId === actor.id) return { ok: false, status: 409, error: "Anda tidak bisa menonaktifkan akun sendiri." };
  if (target.disabled_at) return { ok: false, status: 409, error: "Pengguna sudah nonaktif." };
  // The last-owner rule is in the UPDATE itself, so two owners disabling each
  // other at once cannot both succeed. This write is identified by its own
  // result — disabled at `at` and one generation past what was read — so the
  // revocations below follow it and nothing else.
  const after = Number(target.credential_generation ?? 0) + 1;
  const thisWrite = "EXISTS (SELECT 1 FROM platform_users WHERE id = ? AND disabled_at = ? AND credential_generation = ?)";
  const [changed] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE platform_users SET disabled_at = ?1, credential_generation = credential_generation + 1 WHERE id = ?2 AND disabled_at IS NULL AND credential_generation = ?3
           AND (role <> 'platform_owner' OR (SELECT COUNT(*) FROM platform_users WHERE role = 'platform_owner' AND disabled_at IS NULL AND totp_secret IS NOT NULL AND id <> ?2) >= 1)
           AND ${activeOwner("?4")} AND ${liveSession("?5", "?4")}`,
      )
      .bind(at, userId, after - 1, actor.id, actor.sessionId),
    platformDb
      .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'platform_user_disabled', ?, ?, ? WHERE changes() = 1")
      .bind(PLATFORM_EVENTS_TENANT, `platform:${actor.id}`, at, JSON.stringify({ user: userId, email: target.email, role: target.role, before: "active", after: "disabled" })),
    platformDb.prepare(`UPDATE platform_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${thisWrite}`).bind(at, userId, userId, at, after),
    revokeOpenGrants(platformDb, userId, at, thisWrite, userId, at, after),
    // Links this operator issued die with their authority (Sol T-53 review): a
    // disabled, possibly compromised owner's outstanding enrollment link for a
    // second owner must not stay redeemable.
    revokeIssuedGrants(platformDb, userId, at, thisWrite, userId, at, after),
  ]);
  if (Number(changed.meta?.changes ?? 0) !== 1) return NOT_SAVED;
  return { ok: true, message: `${target.email} dinonaktifkan; sesinya ditutup.` };
}

/**
 * Changes a member's role (owner only). Demoting yourself is refused (another
 * owner does it), and the last-owner rule sits in the UPDATE so two concurrent
 * demotions cannot both leave the console without an active owner. Like a
 * disable, the UPDATE is the only deciding statement (actor still an active
 * owner with a live session) and its side effects are chained on it.
 */
export async function setTeamMemberRole(
  platformDb: D1Database,
  actor: PlatformUser,
  userId: string,
  role: unknown,
  now = new Date(),
): Promise<TeamResult> {
  const refused = ownerOnly(actor);
  if (refused) return refused;
  if (!actor.sessionId) return NO_SESSION;
  if (!PLATFORM_ROLES.includes(role as PlatformRole)) return { ok: false, status: 422, error: "Peran tidak dikenal." };
  const next = role as PlatformRole;
  const target = await platformDb
    .prepare("SELECT id, email, role FROM platform_users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string; role: PlatformRole }>();
  if (!target) return { ok: false, status: 404, error: "Pengguna tidak ditemukan." };
  if (target.role === next) return { ok: false, status: 409, error: "Peran tidak berubah." };
  if (userId === actor.id) return { ok: false, status: 409, error: "Peran akun sendiri diubah oleh owner lain." };
  const [changed] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE platform_users SET role = ?1 WHERE id = ?2 AND role = ?3
           AND (?1 = 'platform_owner' OR (SELECT COUNT(*) FROM platform_users WHERE role = 'platform_owner' AND disabled_at IS NULL AND totp_secret IS NOT NULL AND id <> ?2) >= 1)
           AND ${activeOwner("?4")} AND ${liveSession("?5", "?4")}`,
      )
      .bind(next, userId, target.role, actor.id, actor.sessionId),
    platformDb
      .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'platform_user_role_changed', ?, ?, ? WHERE changes() = 1")
      .bind(PLATFORM_EVENTS_TENANT, `platform:${actor.id}`, now.toISOString(), JSON.stringify({ user: userId, email: target.email, before: target.role, after: next })),
    // A link issued under the old role does not outlive it — only when this
    // change is the one that happened: chained on the audit row, written only
    // if the role UPDATE changed a row. A losing concurrent change revokes nothing.
    revokeOpenGrants(platformDb, userId, now.toISOString(), "changes() = 1"),
    // A demoted owner's outgoing links die too: whenever this member is not an
    // owner after the role UPDATE (a promotion, or a losing demotion, revokes nothing
    // because the member is still or again an owner).
    revokeIssuedGrants(
      platformDb,
      userId,
      now.toISOString(),
      "EXISTS (SELECT 1 FROM platform_users WHERE id = ? AND role <> 'platform_owner')",
      userId,
    ),
  ]);
  if (Number(changed.meta?.changes ?? 0) !== 1) return NOT_SAVED;
  return { ok: true, message: `${target.email} sekarang ${next === "platform_owner" ? "Owner" : "Support"}.` };
}
