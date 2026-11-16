/**
 * Platform sessions (IAM-3): `__Host-adsbook_platform` on platform hosts only,
 * signed with the Worker secret `PLATFORM_AUTH_SECRET`, stored in
 * `PLATFORM_DB.platform_sessions` (revocable, 12 hours). Sign-in needs the
 * password and a TOTP code (spec 07); the error is the same for every
 * failure, and attempts are rate limited per address.
 *
 * The cookie is a random session id and its HMAC; the row is keyed by the
 * id's SHA-256, so a read of the table cannot be replayed as a cookie. A
 * tenant session is never read here, and this cookie is never read on a
 * seller host (host-only cookies are not even sent there).
 */
import { verifyPasswordHash } from "../../lib/auth.ts";
import { checkRateLimit } from "../../lib/rate-limit.ts";
import { ensureControlPlane } from "../control-plane.ts";
import { verifyTotp } from "./totp.ts";

export const PLATFORM_COOKIE_NAME = "__Host-adsbook_platform";
export const PLATFORM_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
export const PLATFORM_SESSION_MS = 12 * 60 * 60 * 1000;
export const PLATFORM_LOGIN_LIMIT = 10;

export type PlatformRole = "platform_owner" | "platform_support";
export type PlatformUser = { id: string; email: string; role: PlatformRole };

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/** The Worker secret; a short or missing one closes platform admin (fail closed). */
export function platformSecret(env: Record<string, unknown> | null | undefined): string {
  const secret = typeof env?.PLATFORM_AUTH_SECRET === "string" ? env.PLATFORM_AUTH_SECRET : "";
  return secret.length >= 32 ? secret : "";
}

export function readPlatformCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(/(?:^|;\s*)__Host-adsbook_platform=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export type LoginResult = { ok: true; cookie: string; user: PlatformUser } | { ok: false; status: 401 | 429 | 503 };

export async function platformLogin(
  env: Record<string, unknown>,
  input: { email?: unknown; password?: unknown; totp?: unknown },
  ip: string,
  now = new Date(),
): Promise<LoginResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const secret = platformSecret(env);
  if (!platformDb || !secret) return { ok: false, status: 503 };
  await ensureControlPlane(platformDb);
  const limit = await checkRateLimit(platformDb, `platform-login:${ip}`, PLATFORM_LOGIN_LIMIT, 15 * 60 * 1000);
  if (!limit.allowed) return { ok: false, status: 429 };

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const row = email
    ? await platformDb
        .prepare("SELECT id, email, password_hash, totp_secret, role FROM platform_users WHERE email = ? AND disabled_at IS NULL")
        .bind(email)
        .first<{ id: string; email: string; password_hash: string; totp_secret: string | null; role: PlatformRole }>()
    : null;
  // Both checks always run, so timing does not tell which failed.
  const [passwordOk, totpStep] = await Promise.all([
    verifyPasswordHash(password, row?.password_hash ?? "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    verifyTotp(row?.totp_secret ?? "AAAAAAAAAAAAAAAA", input.totp),
  ]);
  // MFA is required: a user without an enrolled secret cannot sign in at all.
  if (!row || !row.totp_secret || !passwordOk || totpStep === null) return { ok: false, status: 401 };
  // Each code signs in once: the step is claimed atomically, so a replay (or a
  // concurrent second use) of an accepted code within its window is refused.
  const claimed = await platformDb
    .prepare("UPDATE platform_users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)")
    .bind(totpStep, row.id, totpStep)
    .run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return { ok: false, status: 401 };

  const id = hex(crypto.getRandomValues(new Uint8Array(32)));
  await platformDb
    .prepare("INSERT INTO platform_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(id), row.id, new Date(now.getTime() + PLATFORM_SESSION_MS).toISOString(), now.toISOString())
    .run();
  return { ok: true, cookie: `${id}.${await hmac(secret, id)}`, user: { id: row.id, email: row.email, role: row.role } };
}

/** The signed-in platform user for this request, or null. */
export async function resolvePlatformUser(env: Record<string, unknown>, request: Request, now = new Date()): Promise<PlatformUser | null> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const secret = platformSecret(env);
  const cookie = readPlatformCookie(request);
  if (!platformDb || !secret || !cookie) return null;
  const [id, mac] = cookie.split(".");
  if (!id || !mac || !/^[0-9a-f]{64}$/.test(id) || !equal(mac, await hmac(secret, id))) return null;
  const row = await platformDb
    .prepare(
      `SELECT u.id, u.email, u.role FROM platform_sessions s JOIN platform_users u ON u.id = s.user_id
       WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`,
    )
    .bind(await sha256(id), now.toISOString())
    .first<PlatformUser>();
  return row ?? null;
}

export async function platformLogout(env: Record<string, unknown>, request: Request, now = new Date()): Promise<void> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const cookie = readPlatformCookie(request);
  const id = cookie?.split(".")[0];
  if (!platformDb || !id || !/^[0-9a-f]{64}$/.test(id)) return;
  await platformDb.prepare("UPDATE platform_sessions SET revoked_at = ? WHERE id = ?").bind(now.toISOString(), await sha256(id)).run();
}
