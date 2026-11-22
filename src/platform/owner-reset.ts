/**
 * "Lupa password" for a store **owner** at adsbook.id/lupa-password (IAM-9's
 * self-service sibling). Two steps on one endpoint, `POST /api/platform/owner-reset`:
 *
 * 1. `action: "request_code"` with `email` and a Turnstile token. The answer is
 *    the same `{success, challenge_id}` for every address (non-enumerating): a
 *    real challenge row and an 8-digit mail exist only when the address is the
 *    owner email of an active store; otherwise the id is random and nothing is
 *    stored or sent. Staff reset their password through their owner.
 * 2. `action: "reset"` with `email`, `challenge_id`, `email_code`, `password`
 *    and a fresh Turnstile token. The code is consumed atomically in
 *    `PLATFORM_DB` (the same claim as signup, under its own HKDF purpose, so a
 *    signup code can never reset a password), then the owner's password is
 *    replaced in the store **only if the credential is still the one the code
 *    was mailed for** (revision check), and every session of the store is
 *    revoked in the same tenant batch. Both outcomes are audited.
 *
 * The mail goes to the address the store itself holds as its owner email, so a
 * code proves control of that mailbox. No session is opened here: the owner
 * signs in again at /masuk with the new password.
 */
import { hashAdminPassword, validateNewAdminPassword, EMAIL_USERNAME_PATTERN } from "../lib/admin-credentials.ts";
import { checkRateLimit } from "../lib/rate-limit.ts";
import { CMS_VERSION } from "../lib/version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { emailTransportFromEnv, type EmailTransport } from "./seller-email.ts";
import { verifyTurnstile } from "./signup.ts";
import {
  challengeClaim,
  challengeHash,
  codeDigest,
  emailDigest,
  insertChallenge,
  isChallengeId,
  isEmailCode,
  markChallengeSent,
  newChallengeId,
  newEmailCode,
  resetCodeMessage,
  sendSignupCode,
  verificationKey,
  voidChallenge,
} from "./signup-verification.ts";
import { openTenantDb, type TenantDbEnv } from "./tenant-db.ts";

/** Reset requests per network address per hour (each pass may send a mail). */
export const OWNER_RESET_REQUESTS_PER_IP_PER_HOUR = 10;
/** Code submissions per network address per hour (attempts per code are capped by the challenge itself). */
export const OWNER_RESET_SUBMITS_PER_IP_PER_HOUR = 20;

export type OwnerResetDeps = {
  now?: () => Date;
  verifyTurnstile?: (token: unknown, ip: string) => Promise<boolean>;
  emailTransport?: EmailTransport | null;
  /** Tests: the tenant store without a Durable Object namespace. */
  openStore?: (tenantId: string, cacheVersion: number) => Promise<D1Database>;
};

export type OwnerResetRequestResult =
  | { status: 200; challengeId: string }
  | { status: 400 | 429 | 503; error: string; errors?: Record<string, string> };

export type OwnerResetResult =
  | { status: 200 }
  | { status: 400 | 429 | 500 | 503; error: string; errors?: Record<string, string> };

const UNAVAILABLE = { status: 503, error: "Reset password belum tersedia. Coba lagi beberapa saat lagi." } as const;
const TURNSTILE_FAILED = { status: 400, error: "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", errors: { turnstile: "Verifikasi gagal." } } as const;
const BAD_EMAIL = { status: 400, error: "Periksa kembali isian formulir.", errors: { email: "Masukkan email yang valid." } } as const;
const CODE_INVALID_MESSAGE = "Kode salah atau sudah tidak berlaku. Minta kode baru lalu coba lagi.";
const CODE_INVALID = { status: 400, error: CODE_INVALID_MESSAGE, errors: { emailCode: CODE_INVALID_MESSAGE } } as const;
const HOUR_MS = 60 * 60 * 1000;

const normalizeEmail = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

type OwnerTarget = { tenantId: string; cacheVersion: number; ownerEmail: string };

/** The active store whose owner email this is, or null. Staff identifiers never match. */
async function ownerTarget(platformDb: D1Database, email: string): Promise<OwnerTarget | null> {
  const row = await platformDb
    .prepare(
      `SELECT t.id, t.cache_version, t.owner_email FROM tenants t
        WHERE lower(trim(t.owner_email)) = ? AND t.status = 'active'
        LIMIT 1`,
    )
    .bind(email)
    .first<{ id: string; cache_version: number; owner_email: string }>();
  return row ? { tenantId: row.id, cacheVersion: Number(row.cache_version), ownerEmail: row.owner_email } : null;
}

const openStore = (env: Record<string, unknown>, target: OwnerTarget, deps: OwnerResetDeps) =>
  deps.openStore
    ? deps.openStore(target.tenantId, target.cacheVersion)
    : openTenantDb(env as TenantDbEnv, { tenantId: target.tenantId, cacheVersion: target.cacheVersion }, CMS_VERSION.schemaVersion);

/** The store's owner credential, matched by role and owner email, exactly as IAM-9 does. */
async function ownerCredential(store: D1Database, ownerEmail: string) {
  return store
    .prepare(
      `SELECT id, username, updated_at FROM admin_credentials
        WHERE role = 'owner' AND (username = ?1 OR email = ?1)
        ORDER BY id LIMIT 1`,
    )
    .bind(ownerEmail)
    .first<{ id: number; username: string; updated_at: string }>();
}

const audit = (platformDb: D1Database, tenantId: string, kind: string, now: Date, detail: Record<string, unknown>) =>
  platformDb
    .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, ?, 'owner:self-service', ?, ?)")
    .bind(tenantId, kind, now.toISOString(), JSON.stringify(detail));

export async function requestOwnerReset(
  env: Record<string, unknown>,
  input: { email?: unknown; turnstileToken?: unknown },
  ip: string,
  deps: OwnerResetDeps = {},
): Promise<OwnerResetRequestResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const key = await verificationKey(env, "reset");
  const transport = deps.emailTransport === undefined ? emailTransportFromEnv(env) : deps.emailTransport;
  if (!platformDb || !env.TENANT_STORE || !key || !transport) return UNAVAILABLE;
  const now = (deps.now ?? (() => new Date()))();

  await ensureControlPlane(platformDb);
  const email = normalizeEmail(input.email);
  if (email.length > 254 || !EMAIL_USERNAME_PATTERN.test(email)) return BAD_EMAIL;
  const limit = await checkRateLimit(platformDb, `owner-reset-request:${ip}`, OWNER_RESET_REQUESTS_PER_IP_PER_HOUR, HOUR_MS, true, "closed");
  if (!limit.allowed) return { status: 429, error: "Terlalu banyak permintaan dari jaringan ini. Coba lagi nanti." };
  const human = await (deps.verifyTurnstile ?? ((token, address) => verifyTurnstile(env, token, address)))(input.turnstileToken, ip);
  if (!human) return TURNSTILE_FAILED;

  // From here on every address gets the same answer.
  const challengeId = newChallengeId();
  const neutral = { status: 200 as const, challengeId };
  const target = await ownerTarget(platformDb, email);
  if (!target) return neutral;

  const code = newEmailCode();
  const idHash = await challengeHash(challengeId);
  const addressDigest = await emailDigest(key, email);
  try {
    const inserted = await insertChallenge(platformDb, {
      idHash,
      emailDigest: addressDigest,
      codeDigest: await codeDigest(key, challengeId, email, code),
      now: now.getTime(),
    }).run();
    // Over the per-address cap or inside the resend gap: answer the same way, send nothing.
    if (Number(inserted.meta?.changes ?? 0) !== 1) return neutral;
  } catch (error) {
    console.error("owner-reset-code-store-failed", { error: error instanceof Error ? error.name : "unknown" });
    return UNAVAILABLE;
  }
  if (!(await sendSignupCode(transport, resetCodeMessage(email, code)))) {
    console.error("owner-reset-code-not-sent", { tenant_id: target.tenantId });
    await voidChallenge(platformDb, idHash).run().catch(() => undefined);
    return UNAVAILABLE;
  }
  try {
    await platformDb.batch([
      ...markChallengeSent(platformDb, idHash, addressDigest),
      audit(platformDb, target.tenantId, "owner_reset_code_sent", now, {}),
    ]);
  } catch (error) {
    console.error("owner-reset-code-mark-failed", { tenant_id: target.tenantId, error: error instanceof Error ? error.name : "unknown" });
    return UNAVAILABLE;
  }
  return neutral;
}

export async function completeOwnerReset(
  env: Record<string, unknown>,
  input: { email?: unknown; challengeId?: unknown; emailCode?: unknown; password?: unknown; turnstileToken?: unknown },
  ip: string,
  deps: OwnerResetDeps = {},
): Promise<OwnerResetResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const key = await verificationKey(env, "reset");
  if (!platformDb || !env.TENANT_STORE || !key) return UNAVAILABLE;
  const now = (deps.now ?? (() => new Date()))();

  await ensureControlPlane(platformDb);
  const email = normalizeEmail(input.email);
  if (email.length > 254 || !EMAIL_USERNAME_PATTERN.test(email)) return BAD_EMAIL;
  if (!isChallengeId(input.challengeId) || !isEmailCode(input.emailCode)) return CODE_INVALID;
  const password = typeof input.password === "string" ? input.password : "";
  const passwordError = validateNewAdminPassword(password, email);
  if (passwordError) return { status: 400, error: passwordError, errors: { password: passwordError } };
  const limit = await checkRateLimit(platformDb, `owner-reset-submit:${ip}`, OWNER_RESET_SUBMITS_PER_IP_PER_HOUR, HOUR_MS, true, "closed");
  if (!limit.allowed) return { status: 429, error: "Terlalu banyak percobaan dari jaringan ini. Coba lagi nanti." };
  const human = await (deps.verifyTurnstile ?? ((token, address) => verifyTurnstile(env, token, address)))(input.turnstileToken, ip);
  if (!human) return TURNSTILE_FAILED;

  const target = await ownerTarget(platformDb, email);
  // No store for this address: answer exactly as a wrong code would.
  if (!target) return CODE_INVALID;
  const store = await openStore(env, target, deps);
  const owner = await ownerCredential(store, target.ownerEmail);
  if (!owner) return CODE_INVALID;

  // Everything refusable is checked; hash before the spend so a slow hash never strands a spent code.
  const passwordHash = await hashAdminPassword(password);
  const claim = await challengeClaim(platformDb, key, { challengeId: input.challengeId, email, code: input.emailCode, now: now.getTime() });
  const [, pending] = await platformDb.batch([
    claim.consume,
    platformDb
      .prepare(`INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) SELECT ?, 'owner_reset_redeemed', 'owner:self-service', ?, ? WHERE ${claim.guard}`)
      .bind(target.tenantId, now.toISOString(), JSON.stringify({ outcome: "pending" }), ...claim.guardBinds),
  ]);
  if (Number(pending.meta?.changes ?? 0) !== 1) return CODE_INVALID;

  // The code is spent. One tenant batch: the owner's password only if the
  // credential is still the revision read above, then every session of the
  // store, only when the password really changed.
  try {
    const [updated] = await store.batch([
      store
        .prepare("UPDATE admin_credentials SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ? AND role = 'owner' AND updated_at = ?")
        .bind(passwordHash, now.toISOString(), owner.id, owner.updated_at),
      store.prepare("DELETE FROM admin_sessions WHERE changes() = 1"),
    ]);
    if (Number(updated.meta?.changes ?? 0) !== 1) {
      await audit(platformDb, target.tenantId, "owner_reset_failed", now, { reason: "credential_changed" }).run().catch(() => undefined);
      return { status: 500, error: "Password belum berubah karena akun baru saja diperbarui. Minta kode baru lalu coba lagi." };
    }
  } catch (error) {
    console.error("owner-reset-tenant-write-failed", { tenant_id: target.tenantId, error: String(error) });
    await audit(platformDb, target.tenantId, "owner_reset_failed", now, { reason: "tenant_write_failed" }).run().catch(() => undefined);
    return { status: 500, error: "Password belum berubah. Minta kode baru lalu coba lagi." };
  }
  await audit(platformDb, target.tenantId, "owner_reset_completed", now, {})
    .run()
    .catch((error) => console.error("owner-reset-outcome-unrecorded", { tenant_id: target.tenantId, error: String(error) }));
  return { status: 200 };
}
