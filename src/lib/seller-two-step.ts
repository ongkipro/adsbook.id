/**
 * T-57 / PR-35: optional seller two-step verification (TOTP), per credential.
 *
 * - Enrollment (signed in, `/admin/profile`): the current password is required;
 *   a fresh secret is shown, and two-step turns on only after a code from it is
 *   proven. Ten one-time recovery codes are shown once; only their SHA-256 is
 *   stored. The secret is sealed with the platform credential key (ADR-040); a
 *   store without that key cannot enroll (fail closed, nothing in plaintext).
 * - Sign-in, on both entry points (`/hello` and `adsbook.id/masuk`): a correct
 *   password for an enrolled credential creates a *challenge*, never a session.
 *   The session (or, on /masuk, the handoff) exists only after a correct code,
 *   or one recovery code, for exactly the credential revision the password was
 *   checked against. 5 minutes, 5 wrong codes, single use; a step is accepted
 *   once (replay).
 * - Turning it off needs the current password and a current code (or a
 *   recovery code). An owner can turn it off for a staff member of the same
 *   store (lost phone); nobody can turn it off for an owner but the owner.
 * - Password reset (`/lupa-password`) neither turns it off nor counts as the
 *   second factor.
 *
 * Enrolling moves `updated_at` (the credential revision that sessions,
 * challenges and platform handoffs pin) and deletes this user's sessions, so
 * nothing issued on the password alone survives it. Turning it off does not.
 */
import { openCredential, sealCredential } from "./credential-crypto.ts";
import { verifyPasswordHash } from "./auth.ts";
import { checkRateLimit } from "./rate-limit.ts";
import { newTotpSecret, otpauthUri, verifyTotp } from "../platform/admin/totp.ts";

/** The sealing context: one per credential, so a sealed secret copied onto another user does not open. */
export const twoStepColumn = (credentialId: number) => `admin_credentials.totp_secret:${credentialId}`;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;
/** Wrong second factors per credential per window, across every challenge and the profile: a password holder gets a few guesses, not a million. */
export const FACTOR_FAILURE_LIMIT = 10;
export const FACTOR_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const factorBucket = (credentialId: number) => `two-step-fail:${credentialId}`;

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** `xxxx-xxxx` from an unambiguous alphabet (no 0/O, 1/l/I). */
function newRecoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => alphabet[byte % alphabet.length]);
  return `${pick.slice(0, 4).join("")}-${pick.slice(4).join("")}`;
}
const normalizeRecovery = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

export type TwoStepState = { enabled: boolean };

type Row = { id: number; username: string; password_hash: string; updated_at: string; totp_secret: string | null; totp_last_step: number | null; recovery_codes: string | null };

async function row(database: D1Database, id: number): Promise<Row | null> {
  return database
    .prepare("SELECT id, username, password_hash, updated_at, totp_secret, totp_last_step, recovery_codes FROM admin_credentials WHERE id = ?")
    .bind(id)
    .first<Row>();
}

/** Whether this credential has two-step on. A sealed secret that cannot be opened here still counts as on (fail closed). */
export async function twoStepEnabled(database: D1Database, credentialId: number): Promise<boolean> {
  const current = await row(database, credentialId);
  return Boolean(current?.totp_secret);
}

/** Step 1 of enrollment: the password, then a fresh secret to scan. Nothing is stored until it is proven. */
export async function beginEnrollment(database: D1Database, credentialId: number, password: string, label: string) {
  const current = await row(database, credentialId);
  if (!current || !(await verifyPasswordHash(password, current.password_hash))) return { ok: false as const, error: "Password saat ini salah." };
  if (current.totp_secret) return { ok: false as const, error: "Verifikasi dua langkah sudah aktif." };
  const secret = newTotpSecret();
  return { ok: true as const, secret, uri: otpauthUri(secret, label) };
}

/**
 * Step 2 of enrollment: the password again and a code from the scanned secret.
 * On success the sealed secret and the recovery digests are stored and every
 * session of this user ends, this one too (each signed in on the password
 * alone); the recovery codes are returned once.
 */
export async function confirmEnrollment(
  database: D1Database,
  credentialId: number,
  input: { password: string; secret: string; code: string },
  now = Date.now(),
) {
  const current = await row(database, credentialId);
  if (!current || !(await verifyPasswordHash(input.password, current.password_hash))) return { ok: false as const, error: "Password saat ini salah." };
  if (current.totp_secret) return { ok: false as const, error: "Verifikasi dua langkah sudah aktif." };
  if (!/^[A-Z2-7]{32}$/.test(input.secret)) return { ok: false as const, error: "Mulai ulang pengaturan verifikasi dua langkah." };
  const step = await verifyTotp(input.secret, input.code, now);
  if (step === null) return { ok: false as const, error: "Kode dari aplikasi autentikator salah. Pastikan jam ponsel tepat lalu coba lagi." };
  let sealed: string;
  try {
    sealed = await sealCredential(database, twoStepColumn(credentialId), input.secret);
  } catch {
    return { ok: false as const, error: "Verifikasi dua langkah belum bisa diaktifkan di toko ini. Hubungi tim adsbook.id." };
  }
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const digests = await Promise.all(codes.map((code) => sha256(normalizeRecovery(code))));
  // Only while still off and still the same revision. `updated_at` moves, so
  // every session, pending challenge and platform handoff issued on the
  // password alone stops working: the next sign-in is a two-step one.
  const revision = new Date(Math.max(now, Date.parse(current.updated_at) + 1 || 0)).toISOString();
  const updated = await database
    .prepare("UPDATE admin_credentials SET totp_secret = ?, totp_last_step = ?, recovery_codes = ?, updated_at = ? WHERE id = ? AND totp_secret IS NULL AND updated_at = ?")
    .bind(sealed, step, JSON.stringify(digests), revision, credentialId, current.updated_at)
    .run();
  if (Number(updated.meta?.changes ?? 0) !== 1) return { ok: false as const, error: "Akun berubah saat pengaturan. Muat ulang halaman lalu coba lagi." };
  await database.batch([
    database.prepare("DELETE FROM admin_sessions WHERE username = ?").bind(current.username),
    database.prepare("DELETE FROM admin_login_challenges WHERE credential_id = ?").bind(credentialId),
  ]);
  return { ok: true as const, recoveryCodes: codes };
}

/**
 * Proves the second factor for one credential: a 6-digit code (each step once)
 * or one recovery code (removed when used). The write is conditional, so two
 * concurrent uses of the same code cannot both pass.
 */
export async function proveSecondFactor(database: D1Database, credentialId: number, code: string, now = Date.now()): Promise<boolean> {
  // Fail closed on a store error: a limiter that cannot count lets nothing through.
  const budget = await checkRateLimit(database, factorBucket(credentialId), FACTOR_FAILURE_LIMIT, FACTOR_FAILURE_WINDOW_MS, false, "closed");
  if (!budget.allowed) return false;
  const proven = await checkFactor(database, credentialId, code, now);
  if (!proven) await checkRateLimit(database, factorBucket(credentialId), FACTOR_FAILURE_LIMIT, FACTOR_FAILURE_WINDOW_MS, true, "closed");
  return proven;
}

async function checkFactor(database: D1Database, credentialId: number, code: string, now: number): Promise<boolean> {
  const current = await row(database, credentialId);
  if (!current?.totp_secret) return false;
  const value = code.trim();
  if (/^\d{6}$/.test(value)) {
    const secret = await openCredential(database, twoStepColumn(credentialId), current.totp_secret);
    if (!secret) return false;
    const step = await verifyTotp(secret, value, now);
    if (step === null) return false;
    const claimed = await database
      .prepare("UPDATE admin_credentials SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)")
      .bind(step, credentialId, step)
      .run();
    return Number(claimed.meta?.changes ?? 0) === 1;
  }
  const normalized = normalizeRecovery(value);
  if (normalized.length !== 8) return false;
  const digest = await sha256(normalized);
  const list: string[] = JSON.parse(current.recovery_codes || "[]");
  if (!list.includes(digest)) return false;
  const next = list.filter((entry) => entry !== digest);
  const spent = await database
    .prepare("UPDATE admin_credentials SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?")
    .bind(JSON.stringify(next), credentialId, current.recovery_codes)
    .run();
  return Number(spent.meta?.changes ?? 0) === 1;
}

/** How many recovery codes this credential has left (shown in the profile). */
export async function recoveryCodesLeft(database: D1Database, credentialId: number): Promise<number> {
  const current = await row(database, credentialId);
  return current?.recovery_codes ? (JSON.parse(current.recovery_codes) as string[]).length : 0;
}

/** Turns two-step off: the user's own password and a current factor. */
export async function disableOwnTwoStep(database: D1Database, credentialId: number, input: { password: string; code: string }, now = Date.now()) {
  const current = await row(database, credentialId);
  if (!current || !(await verifyPasswordHash(input.password, current.password_hash))) return { ok: false as const, error: "Password saat ini salah." };
  if (!current.totp_secret) return { ok: false as const, error: "Verifikasi dua langkah belum aktif." };
  if (!(await proveSecondFactor(database, credentialId, input.code, now))) return { ok: false as const, error: "Kode verifikasi salah." };
  await clearTwoStep(database, credentialId);
  return { ok: true as const };
}

/** The write that turns it off (also used by an owner for a staff member). Pending challenges die with it. */
export async function clearTwoStep(database: D1Database, credentialId: number) {
  await database.batch([
    database.prepare("UPDATE admin_credentials SET totp_secret = NULL, totp_last_step = NULL, recovery_codes = NULL WHERE id = ?").bind(credentialId),
    database.prepare("DELETE FROM admin_login_challenges WHERE credential_id = ?").bind(credentialId),
  ]);
}

// ---- the sign-in challenge -------------------------------------------------

export type ChallengeCredential = { id: number; updatedAt: string };

/** After a correct password for an enrolled credential: a challenge token, never a session. */
export async function createLoginChallenge(database: D1Database, credential: ChallengeCredential, now = new Date()): Promise<string> {
  const token = randomHex(32);
  await database.batch([
    database.prepare("DELETE FROM admin_login_challenges WHERE expires_at <= ?").bind(now.toISOString()),
    database
      .prepare("INSERT INTO admin_login_challenges (token_hash, credential_id, credential_updated_at, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)")
      .bind(await sha256(token), credential.id, credential.updatedAt, new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(), now.toISOString()),
  ]);
  return token;
}

export type ChallengeOutcome =
  | { ok: true; credentialId: number; credentialUpdatedAt: string }
  | { ok: false; reason: "invalid" | "wrong_code" | "exhausted" };

/**
 * Redeems a challenge with a code. A wrong code spends one attempt; the fifth
 * ends the challenge. A right code consumes it (one statement, so a race has
 * one winner) and names the credential revision it was issued for; the caller
 * checks that revision is still current before opening a session.
 */
export async function redeemLoginChallenge(
  database: D1Database,
  token: unknown,
  code: unknown,
  now = new Date(),
  /** adsbook.id/masuk: the credential the identifier names; a challenge for anyone else is unknown. */
  expectedCredentialId?: number,
): Promise<ChallengeOutcome> {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) || typeof code !== "string") return { ok: false, reason: "invalid" };
  const hash = await sha256(token);
  const challenge = await database
    .prepare("SELECT credential_id, credential_updated_at, attempts FROM admin_login_challenges WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, now.toISOString())
    .first<{ credential_id: number; credential_updated_at: string; attempts: number }>();
  if (!challenge) return { ok: false, reason: "invalid" };
  if (expectedCredentialId !== undefined && Number(challenge.credential_id) !== expectedCredentialId) return { ok: false, reason: "invalid" };
  if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) return { ok: false, reason: "exhausted" };
  if (!(await proveSecondFactor(database, challenge.credential_id, code, now.getTime()))) {
    await database.prepare("UPDATE admin_login_challenges SET attempts = attempts + 1 WHERE token_hash = ?").bind(hash).run();
    return { ok: false, reason: challenge.attempts + 1 >= CHALLENGE_MAX_ATTEMPTS ? "exhausted" : "wrong_code" };
  }
  const consumed = await database.prepare("DELETE FROM admin_login_challenges WHERE token_hash = ? RETURNING credential_id").bind(hash).first();
  if (!consumed) return { ok: false, reason: "invalid" };
  return { ok: true, credentialId: challenge.credential_id, credentialUpdatedAt: challenge.credential_updated_at };
}

/** The /hello challenge cookie: HttpOnly, host-only, five minutes. */
export const TWO_STEP_COOKIE_NAME = "__Host-adsbook_two_step";
export const TWO_STEP_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;

/** What a refused code says, by reason; `exhausted` and `invalid` send the user back to the password. */
export function challengeRefusal(reason: "invalid" | "wrong_code" | "exhausted"): string {
  if (reason === "wrong_code") return "Kode verifikasi salah. Periksa aplikasi autentikator lalu coba lagi.";
  if (reason === "exhausted") return "Terlalu banyak kode salah. Masuk lagi dengan password Anda.";
  return "Langkah verifikasi sudah berakhir. Masuk lagi dengan password Anda.";
}

/** The platform's password reset page, from a seller host (local dev keeps its platform host and port). */
export function forgotPasswordUrl(storeUrl: URL): string {
  if (/(^|\.)localhost$/.test(storeUrl.hostname)) return `${storeUrl.protocol}//app.localhost${storeUrl.port ? `:${storeUrl.port}` : ""}/lupa-password`;
  return "https://adsbook.id/lupa-password";
}
