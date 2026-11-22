/**
 * IAM-11 (T-53): the platform operator's credential lifecycle.
 *
 * - Self change: the operator's current password and a fresh, unused TOTP
 *   code; the hash changes, every session of theirs (this one too) and every
 *   open grant is revoked, and the change is audited, in one batch. TOTP
 *   enrollment is kept.
 * - Owner-assisted reset: a platform_owner, stepped up with their own fresh
 *   TOTP code, issues a short-lived single-use password-setup link for another
 *   non-owner operator. Issuing revokes that operator's open grants and
 *   sessions. The link is shown to the owner once, to pass on through a
 *   verified channel; the token lives in the URL fragment, which no request
 *   carries, so it reaches no server log. Redeeming it needs the operator's
 *   enrolled TOTP as well: the link alone never changes a password.
 * - Enrollment: a new operator is created without password or TOTP and gets
 *   a distinct `enrollment` link; they set the password and prove a code
 *   from their new authenticator before the account can sign in.
 *
 * There is no button that resets both factors and no self-service email
 * recovery. An owner, or anyone who lost their authenticator, goes through
 * the audited break-glass runbook. Only the token's SHA-256 is stored; no
 * audit row carries a password, token or TOTP secret.
 */
import { hashAdminPassword } from "../../lib/admin-credentials.ts";
import { verifyPasswordHash } from "../../lib/auth.ts";
import { checkRateLimit } from "../../lib/rate-limit.ts";
import type { PlatformUser } from "./session.ts";
import { newTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";

export const PLATFORM_EVENTS_TENANT = "_platform";
export type GrantPurpose = "password_reset" | "enrollment";
export const GRANT_TTL_MS: Record<GrantPurpose, number> = { password_reset: 30 * 60 * 1000, enrollment: 24 * 60 * 60 * 1000 };
/** The page that redeems a grant; the token follows in the fragment. */
export const GRANT_PAGE = "/platform/akses";
/** A password hash no password verifies: an operator not yet enrolled. */
export const NOT_ENROLLED_HASH = "!enrollment-pending";

/**
 * The database's own clock at the moment a statement runs, in the stored ISO
 * form (`toISOString`: millisecond precision, `Z`). Expiry in a write is judged
 * against this, never against a timestamp taken at request start: password
 * hashing and TOTP checks sit in between, and a session or link that expires
 * in that window must not authorize the write.
 */
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * The authorizing session, as of the write: still the actor's, not revoked,
 * not expired (database clock). Every credential and team write carries it, so
 * a request authorized before a revocation (a disable, even one followed by
 * re-enabling, a password change, a reset) or an expiry cannot commit after it.
 */
export const liveSession = (sessionRef: string, userRef: string) =>
  `EXISTS (SELECT 1 FROM platform_sessions WHERE id = ${sessionRef} AND user_id = ${userRef} AND revoked_at IS NULL AND expires_at > ${SQL_NOW})`;
const NO_SESSION = { ok: false as const, status: 401, error: "Sesi tidak berlaku. Masuk lagi." };

/**
 * The operator-link switch, from the Worker secret `PLATFORM_CREDENTIAL_LINKS`
 * (a secret, so wrangler.jsonc keeps its two public vars):
 * - unset or empty — links open (normal);
 * - `off` — no link is issued or redeemed (members cannot be added); self
 *   change and sign-in keep working;
 * - an ISO instant — links open, but every grant created before it is dead:
 *   the fence for reopening after a roll-forward or a control-plane restore;
 * - anything else — treated as `off` (fail closed).
 */
export type LinkPolicy = { open: boolean; notBefore: string | null };
/**
 * Read the switch where it is used: once to refuse early, and again just before
 * the commit batch, whose not-before fence is in the SQL itself. Within one
 * Worker version the binding does not change mid-request; a changed secret is a
 * new version, so requests already running finish on the old one — containment
 * is the switch plus a drain (PLATFORM-RUNBOOK), and this re-read keeps the
 * code honest wherever the value can change under it.
 */
export type LinkGate = () => LinkPolicy;
export function credentialLinkPolicy(env: Record<string, unknown> | null | undefined): LinkPolicy {
  const raw = typeof env?.PLATFORM_CREDENTIAL_LINKS === "string" ? env.PLATFORM_CREDENTIAL_LINKS.trim() : "";
  if (!raw) return { open: true, notBefore: null };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(raw) && !Number.isNaN(Date.parse(raw))) return { open: true, notBefore: new Date(raw).toISOString() };
  return { open: false, notBefore: null };
}
const LINKS_CLOSED = { ok: false as const, status: 503, error: "Tautan akses sedang dinonaktifkan oleh owner platform. Coba lagi nanti." };

export type CredentialResult<T = undefined> = { ok: true; message: string; value?: T } | { ok: false; status: number; error: string };

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const newToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/** The password rule every operator password follows. */
export function operatorPasswordProblem(password: string, email: string): string | null {
  if (password.length < 12 || password.length > 128) return "Password 12–128 karakter.";
  if (password.trim().toLowerCase() === email.toLowerCase()) return "Password tidak boleh sama dengan email.";
  return null;
}

/** Claims a TOTP step for a user once: a replay, or a second use of the same code anywhere, is refused. */
export async function claimTotpStep(platformDb: D1Database, userId: string, step: number): Promise<boolean> {
  const claimed = await platformDb
    .prepare("UPDATE platform_users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)")
    .bind(step, userId, step)
    .run();
  return Number(claimed.meta?.changes ?? 0) === 1;
}

const auditStatement = (platformDb: D1Database, kind: string, actor: string, at: string, detail: Record<string, unknown>, guard = "", ...guardArgs: unknown[]) =>
  platformDb
    .prepare(`INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, ?, ?, ?, ? ${guard}`)
    .bind(PLATFORM_EVENTS_TENANT, kind, actor, at, JSON.stringify(detail), ...guardArgs);

/**
 * Self change. Both factors are checked every time (timing does not tell which
 * failed); the code is claimed only once both pass, so a wrong password does
 * not burn it. The hash update is fenced on the old hash, and the session and
 * grant revocations on the new one, so two concurrent changes cannot leave a
 * session open after either.
 */
export async function changeOwnPassword(
  platformDb: D1Database,
  user: PlatformUser,
  input: { current?: unknown; totp?: unknown; password?: unknown },
  now = new Date(),
): Promise<CredentialResult> {
  if (!user.sessionId) return NO_SESSION;
  const current = typeof input.current === "string" ? input.current : "";
  const next = typeof input.password === "string" ? input.password : "";
  const row = await platformDb
    .prepare("SELECT password_hash, totp_secret, email FROM platform_users WHERE id = ? AND disabled_at IS NULL")
    .bind(user.id)
    .first<{ password_hash: string; totp_secret: string | null; email: string }>();
  if (!row?.totp_secret) return { ok: false, status: 401, error: "Sesi tidak berlaku. Masuk lagi." };
  const problem = operatorPasswordProblem(next, row.email);
  if (problem) return { ok: false, status: 422, error: problem };
  if (next === current) return { ok: false, status: 422, error: "Password baru harus berbeda dari yang sekarang." };
  // Counted only once the new password is well-formed: what is limited is guessing the current factors.
  const limit = await checkRateLimit(platformDb, `platform-password:${user.id}`, 5, 15 * 60 * 1000);
  if (!limit.allowed) return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." };
  const [passwordOk, step] = await Promise.all([verifyPasswordHash(current, row.password_hash), verifyTotp(row.totp_secret, input.totp, now.getTime())]);
  if (!passwordOk || step === null) return { ok: false, status: 401, error: "Password sekarang atau kode autentikator salah." };
  if (!(await claimTotpStep(platformDb, user.id, step))) return { ok: false, status: 401, error: "Kode ini sudah dipakai. Tunggu kode berikutnya." };

  const hash = await hashAdminPassword(next);
  const at = now.toISOString();
  const changedTo = "EXISTS (SELECT 1 FROM platform_users WHERE id = ?2 AND password_hash = ?3)";
  const [changed] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE platform_users SET password_hash = ?1, credential_generation = credential_generation + 1
         WHERE id = ?2 AND password_hash = ?3 AND disabled_at IS NULL AND ${liveSession("?4", "?2")}`,
      )
      .bind(hash, user.id, row.password_hash, user.sessionId),
    auditStatement(platformDb, "platform_password_changed", `platform:${user.id}`, at, { user: user.id, email: row.email, before: "password", after: "changed" }, "WHERE changes() = 1"),
    platformDb.prepare(`UPDATE platform_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND ${changedTo}`).bind(at, user.id, hash),
    platformDb.prepare(`UPDATE platform_credential_grants SET revoked_at = ?1 WHERE user_id = ?2 AND consumed_at IS NULL AND revoked_at IS NULL AND ${changedTo}`).bind(at, user.id, hash),
  ]);
  if (Number(changed.meta?.changes ?? 0) !== 1) return { ok: false, status: 409, error: "Password atau sesi Anda berubah di tempat lain. Masuk lagi." };
  return { ok: true, message: "Password diganti. Semua sesi ditutup; masuk lagi dengan password baru." };
}

/** Step-up: the acting owner proves a fresh TOTP code of their own before a credential action. */
export async function stepUp(platformDb: D1Database, actor: PlatformUser, code: unknown, now = new Date()): Promise<CredentialResult> {
  const limit = await checkRateLimit(platformDb, `platform-stepup:${actor.id}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." };
  const row = await platformDb.prepare("SELECT totp_secret FROM platform_users WHERE id = ? AND disabled_at IS NULL").bind(actor.id).first<{ totp_secret: string | null }>();
  const step = await verifyTotp(row?.totp_secret, code, now.getTime());
  if (step === null) return { ok: false, status: 401, error: "Kode autentikator Anda salah." };
  if (!(await claimTotpStep(platformDb, actor.id, step))) return { ok: false, status: 401, error: "Kode ini sudah dipakai. Tunggu kode berikutnya." };
  return { ok: true, message: "" };
}

/** Revokes a user's open grants inside another batch, guarded by that batch's own fence. */
export const revokeOpenGrants = (platformDb: D1Database, userId: string, at: string, fence: string, ...fenceArgs: unknown[]) =>
  platformDb
    .prepare(`UPDATE platform_credential_grants SET revoked_at = ? WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND ${fence}`)
    .bind(at, userId, ...fenceArgs);

/** The acting owner, as of the write itself: active, enrolled, still an owner. Every credential write is fenced on it. */
export const activeOwner = (userRef = "?") =>
  `EXISTS (SELECT 1 FROM platform_users WHERE id = ${userRef} AND role = 'platform_owner' AND disabled_at IS NULL AND totp_secret IS NOT NULL)`;

/**
 * The statements that issue one grant, for a batch of their own or inside a
 * larger one (adding a member). The insert carries every eligibility rule —
 * the target's state and the actor still being an active owner — evaluated at
 * the write, so a target promoted, enrolled or disabled, or an actor demoted
 * or disabled, in between gets no grant; the audit row, the older grants'
 * revocation, the session revocation and the generation move run only if it
 * was written. Statement 0 is the insert.
 */
export async function grantStatements(
  platformDb: D1Database,
  actor: PlatformUser,
  target: { id: string; email: string },
  purpose: GrantPurpose,
  now: Date,
  /**
   * `afterDecidingInsert`: the statement right before this one in the same
   * batch already made the one authorization decision (adding a member). The
   * grant then follows that insert's result (`changes() = 1`) and re-checks
   * nothing that can change between statements — a session expiring between
   * the two must not leave a member without its grant.
   */
  afterDecidingInsert = false,
) {
  const actorId = actor.id;
  const token = newToken();
  const id = await sha256(token);
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS[purpose]).toISOString();
  const eligible = purpose === "password_reset" ? "totp_secret IS NOT NULL AND role <> 'platform_owner'" : "totp_secret IS NULL";
  const written = "EXISTS (SELECT 1 FROM platform_credential_grants WHERE id = ?)";
  const statements = [
    platformDb
      .prepare(
        `INSERT INTO platform_credential_grants (id, purpose, user_id, actor_id, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM platform_users WHERE id = ?3 AND disabled_at IS NULL AND ${eligible})
           AND ${afterDecidingInsert ? "changes() = 1" : `${activeOwner("?4")} AND ${liveSession("?7", "?4")}`}`,
      )
      .bind(...[id, purpose, target.id, actorId, at, expiresAt, ...(afterDecidingInsert ? [] : [actor.sessionId ?? ""])]),
    auditStatement(platformDb, "platform_access_link_issued", `platform:${actorId}`, at, { user: target.id, email: target.email, purpose, expires_at: expiresAt }, `WHERE ${written}`, id),
    platformDb.prepare(`UPDATE platform_credential_grants SET revoked_at = ? WHERE user_id = ? AND id <> ? AND consumed_at IS NULL AND revoked_at IS NULL AND ${written}`).bind(at, target.id, id, id),
    platformDb.prepare(`UPDATE platform_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${written}`).bind(at, target.id, id),
    platformDb.prepare(`UPDATE platform_users SET credential_generation = credential_generation + 1 WHERE id = ? AND ${written}`).bind(target.id, id),
  ];
  return { statements, token, expiresAt };
}

/**
 * Issues a grant behind the owner's step-up code, checked after every
 * refusable rule so a refused target does not cost the owner a code. A code
 * that passed step-up is spent even if the write is then refused (a code is
 * single-use whatever follows); the owner retries with the next one.
 */
export async function issueCredentialGrant(
  platformDb: D1Database,
  actor: PlatformUser,
  targetId: string,
  purpose: GrantPurpose,
  stepUpCode: unknown,
  origin: string,
  links: LinkGate,
  now = new Date(),
): Promise<CredentialResult<{ link: string; expiresAt: string; email: string }>> {
  if (actor.role !== "platform_owner") return { ok: false, status: 403, error: "Hanya owner platform yang boleh membuat tautan akses." };
  if (!actor.sessionId) return NO_SESSION;
  if (!links().open) return LINKS_CLOSED;
  if (targetId === actor.id) return { ok: false, status: 409, error: "Ganti password Anda sendiri di menu Akun." };
  const target = await platformDb
    .prepare("SELECT email, role, totp_secret IS NOT NULL AS enrolled, disabled_at FROM platform_users WHERE id = ?")
    .bind(targetId)
    .first<{ email: string; role: string; enrolled: number; disabled_at: string | null }>();
  if (!target) return { ok: false, status: 404, error: "Pengguna tidak ditemukan." };
  if (target.disabled_at) return { ok: false, status: 409, error: "Aktifkan pengguna ini dulu." };
  if (purpose === "password_reset" && !target.enrolled) return { ok: false, status: 409, error: "Akun ini belum aktif; buat ulang tautan aktivasi." };
  if (purpose === "enrollment" && target.enrolled) return { ok: false, status: 409, error: "Akun ini sudah aktif." };
  if (purpose === "password_reset" && target.role === "platform_owner") {
    return { ok: false, status: 409, error: "Password owner tidak direset dari console; ikuti runbook break-glass." };
  }
  const stepped = await stepUp(platformDb, actor, stepUpCode, now);
  if (!stepped.ok) return stepped;
  const grant = await grantStatements(platformDb, actor, { id: targetId, email: target.email }, purpose, now);
  if (!links().open) return LINKS_CLOSED; // re-read at commit
  const [inserted] = await platformDb.batch(grant.statements);
  if (Number(inserted.meta?.changes ?? 0) !== 1) return { ok: false, status: 409, error: "Sesi, peran Anda, atau status pengguna ini berubah. Muat ulang halaman." };
  return {
    ok: true,
    message: purpose === "enrollment" ? `Tautan aktivasi untuk ${target.email} dibuat.` : `Tautan reset password untuk ${target.email} dibuat; sesinya ditutup.`,
    value: { link: `${origin}${GRANT_PAGE}#${grant.token}`, expiresAt: grant.expiresAt, email: target.email },
  };
}

type OpenGrant = { id: string; purpose: GrantPurpose; user_id: string; email: string; totp_secret: string | null };
const REFUSED = { ok: false as const, status: 410, error: "Tautan ini tidak berlaku lagi. Minta tautan baru ke owner platform." };

async function openGrant(platformDb: D1Database, token: unknown, policy: LinkPolicy, now: Date): Promise<OpenGrant | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  return platformDb
    .prepare(
      `SELECT g.id, g.purpose, g.user_id, u.email, u.totp_secret FROM platform_credential_grants g JOIN platform_users u ON u.id = g.user_id
       WHERE g.id = ? AND g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > ? AND u.disabled_at IS NULL
         AND (g.purpose = 'enrollment') = (u.totp_secret IS NULL) AND g.created_at >= ?`,
    )
    .bind(await sha256(token), now.toISOString(), policy.notBefore ?? "")
    .first<OpenGrant>();
}

/**
 * What the redeem page shows. Reading a grant never spends it. Enrollment gets
 * a new TOTP secret for this page only; it is not stored until a code from it
 * is proven at redemption.
 */
export async function peekCredentialGrant(
  platformDb: D1Database,
  token: unknown,
  ip: string,
  links: LinkGate,
  now = new Date(),
): Promise<CredentialResult<{ purpose: GrantPurpose; email: string; totpSecret?: string; otpauthUri?: string }>> {
  const policy = links();
  if (!policy.open) return LINKS_CLOSED;
  const limit = await checkRateLimit(platformDb, `platform-grant:${ip}`, 20, 15 * 60 * 1000);
  if (!limit.allowed) return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." };
  const grant = await openGrant(platformDb, token, policy, now);
  if (!grant) return REFUSED;
  if (grant.purpose === "password_reset") return { ok: true, message: "", value: { purpose: grant.purpose, email: grant.email } };
  const secret = newTotpSecret();
  return { ok: true, message: "", value: { purpose: grant.purpose, email: grant.email, totpSecret: secret, otpauthUri: otpauthUri(secret, grant.email) } };
}

/**
 * Redeems a grant. Everything refusable (password rule, the TOTP code) is
 * checked before the grant is touched, so a typo does not cost the link. Then
 * one batch: the grant is consumed under this attempt's nonce, and the
 * password (plus, for enrollment, the proven TOTP secret), the session
 * revocation and the audit row are written only behind that nonce.
 */
export async function consumeCredentialGrant(
  platformDb: D1Database,
  token: unknown,
  input: { password?: unknown; totp?: unknown; totpSecret?: unknown },
  ip: string,
  links: LinkGate,
  now = new Date(),
): Promise<CredentialResult> {
  const policy = links();
  if (!policy.open) return LINKS_CLOSED;
  const limit = await checkRateLimit(platformDb, `platform-grant:${ip}`, 20, 15 * 60 * 1000);
  if (!limit.allowed) return { ok: false, status: 429, error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." };
  const grant = await openGrant(platformDb, token, policy, now);
  if (!grant) return REFUSED;
  const password = typeof input.password === "string" ? input.password : "";
  const problem = operatorPasswordProblem(password, grant.email);
  if (problem) return { ok: false, status: 422, error: problem };
  const enrolling = grant.purpose === "enrollment";
  const secret = enrolling ? (typeof input.totpSecret === "string" && /^[A-Z2-7]{32}$/.test(input.totpSecret) ? input.totpSecret : "") : grant.totp_secret;
  const step = await verifyTotp(secret, input.totp, now.getTime());
  if (!secret || step === null) return { ok: false, status: 401, error: "Kode autentikator salah." };
  // A reset proves the enrolled authenticator, and that code is spent like a sign-in code.
  if (!enrolling && !(await claimTotpStep(platformDb, grant.user_id, step))) return { ok: false, status: 401, error: "Kode ini sudah dipakai. Tunggu kode berikutnya." };

  const nonce = newToken();
  const at = now.toISOString();
  const hash = await hashAdminPassword(password);
  const fence = "EXISTS (SELECT 1 FROM platform_credential_grants WHERE id = ? AND consumed_by = ?)";
  // Re-read at commit: closed now refuses; a not-before set meanwhile is in the grant update below.
  const commit = links();
  if (!commit.open) return LINKS_CLOSED;
  const [consumed] = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE platform_credential_grants SET consumed_at = ?1, consumed_by = ?2
         WHERE id = ?3 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${SQL_NOW} AND created_at >= ?6
           AND EXISTS (SELECT 1 FROM platform_users u WHERE u.id = ?4 AND u.disabled_at IS NULL AND (u.totp_secret IS NULL) = ?5)`,
      )
      .bind(at, nonce, grant.id, grant.user_id, enrolling ? 1 : 0, commit.notBefore ?? ""),
    enrolling
      ? platformDb.prepare(`UPDATE platform_users SET password_hash = ?, totp_secret = ?, totp_last_step = ?, credential_generation = credential_generation + 1 WHERE id = ? AND ${fence}`).bind(hash, secret, step, grant.user_id, grant.id, nonce)
      : platformDb.prepare(`UPDATE platform_users SET password_hash = ?, credential_generation = credential_generation + 1 WHERE id = ? AND ${fence}`).bind(hash, grant.user_id, grant.id, nonce),
    platformDb.prepare(`UPDATE platform_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${fence}`).bind(at, grant.user_id, grant.id, nonce),
    auditStatement(platformDb, "platform_access_link_used", `platform:${grant.user_id}`, at, { user: grant.user_id, email: grant.email, purpose: grant.purpose }, `WHERE ${fence}`, grant.id, nonce),
  ]);
  if (Number(consumed.meta?.changes ?? 0) !== 1) return REFUSED;
  return { ok: true, message: enrolling ? "Akun aktif. Masuk dengan email, password, dan kode autentikator." : "Password diganti. Masuk dengan password baru." };
}
