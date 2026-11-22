/**
 * adsbook.id/masuk (AUTH-LOGIN-REGISTER-UX-SPEC §1.3): one door for every
 * store. An email or username and a password; the account is found from the
 * identifier (`platform_identities`, which names the store and the credential),
 * the password is checked against that store's own credential, and the answer
 * is a short `login` handoff for that credential revision, which the browser
 * posts to the store's subdomain, where the session is opened (`/api/handoff`).
 * No cookie is set on the platform host.
 *
 * Every refusal reads the same and costs about the same (LOGIN-13): an
 * unknown identifier, an inactive store, a missing or seeded credential and a
 * wrong password all run one PBKDF2 verification and answer one message.
 *
 * Limits (review 2026-11-18, LOGIN-19's anti-lockout shape): failures count
 * per (address, identifier) pair — 8 per 10 minutes, cleared by a correct
 * password — under a loose per-address ceiling every attempt spends. A guesser
 * on one network can never lock the owner out from another, and a known and an
 * unknown identifier meet exactly the same limits. A failure also lands in the
 * store's own /hello record for that user, so /hello sees the guesses made here.
 */
import {
  DEFAULT_ADMIN_PASSWORD_HASH,
  getAdminCredential,
  getAdminCredentialById,
  isDefaultAdminCredential,
  verifyAdminLoginPassword,
  type AdminCredential,
} from "../lib/admin-credentials.ts";
import { getDefaultAdminRoute, verifyPasswordHash } from "../lib/auth.ts";
import { checkRateLimit, clearAdminLoginFailures, recordAdminLoginFailure } from "../lib/rate-limit.ts";
import { challengeRefusal, createLoginChallenge, redeemLoginChallenge, twoStepEnabled } from "../lib/seller-two-step.ts";
import { CMS_VERSION } from "../lib/version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { issueHandoff } from "./handoff.ts";
import { identityKey, resolvePlatformIdentity, type ResolvedIdentity } from "./identities.ts";
import { openTenantDb, type TenantDbEnv } from "./tenant-db.ts";

export const LOGIN_REFUSED = "Email/username atau password belum sesuai.";
export const LOGIN_RATE_LIMITED = "Terlalu banyak percobaan masuk. Coba lagi dalam beberapa menit.";
const WINDOW_MS = 10 * 60 * 1000;
export const PLATFORM_LOGIN_LIMITS = { perAddress: 30, perPair: 8 } as const;

const addressKey = (ip: string) => `platform-login-ip:${ip}`;
const pairKey = (ip: string, identifier: string) => `platform-login-pair:${ip}|${identifier || "-"}`;

export type StoreLoginResult =
  | { status: 200; host: string; token: string; next: string }
  /** T-57: the password was right for an enrolled credential; no handoff until the code. */
  | { status: 202; challenge: string }
  | { status: 401 | 429 | 503; error: string };

export type StoreLoginDeps = {
  now?: () => Date;
  /** Tests: the tenant store without a Durable Object namespace. */
  openStore?: (tenantId: string, cacheVersion: number) => Promise<D1Database>;
};

/** The credential an identifier signs in: by the id the registry holds; an owner email before its first sync, the owner. */
async function credentialFor(database: D1Database, identity: ResolvedIdentity, identifier: string): Promise<AdminCredential | null> {
  if (identity.credentialId !== null) return getAdminCredentialById(database, identity.credentialId);
  if (identity.kind !== "owner_email") return getAdminCredential(database, identifier);
  const owner = await database.prepare("SELECT id FROM admin_credentials WHERE role = 'owner' ORDER BY id LIMIT 1").first<{ id: number }>();
  return owner ? getAdminCredentialById(database, owner.id) : null;
}

export async function storeLogin(
  env: Record<string, unknown>,
  input: { identifier?: unknown; password?: unknown },
  ip: string,
  deps: StoreLoginDeps = {},
): Promise<StoreLoginResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  if (!platformDb?.prepare) return { status: 503, error: "Masuk belum tersedia. Coba lagi beberapa saat lagi." };
  await ensureControlPlane(platformDb);
  const identifier = identityKey(input.identifier);
  const password = typeof input.password === "string" ? input.password.slice(0, 1024) : "";

  // Before any lookup: the address ceiling is spent by every attempt; the pair is only read here.
  const [address, pair] = await Promise.all([
    checkRateLimit(platformDb, addressKey(ip), PLATFORM_LOGIN_LIMITS.perAddress, WINDOW_MS, true),
    checkRateLimit(platformDb, pairKey(ip, identifier), PLATFORM_LOGIN_LIMITS.perPair, WINDOW_MS, false),
  ]);
  if (!address.allowed || !pair.allowed) return { status: 429, error: LOGIN_RATE_LIMITED };

  let store: D1Database | null = null;
  let failedUsername = identifier;
  const refuse = async (verified: boolean): Promise<StoreLoginResult> => {
    // The work floor: one discarded verification, as long as a real one.
    if (!verified) await verifyPasswordHash(password, DEFAULT_ADMIN_PASSWORD_HASH);
    await checkRateLimit(platformDb, pairKey(ip, identifier), PLATFORM_LOGIN_LIMITS.perPair, WINDOW_MS, true);
    if (store) await recordAdminLoginFailure(store, failedUsername, ip).catch(() => undefined);
    return { status: 401, error: LOGIN_REFUSED };
  };
  if (!identifier || !password) return refuse(false);

  const identity = await resolvePlatformIdentity(platformDb, identifier);
  if (!identity) return refuse(false);
  store = await (deps.openStore
    ? deps.openStore(identity.tenantId, identity.cacheVersion)
    : openTenantDb(env as TenantDbEnv, { tenantId: identity.tenantId, cacheVersion: identity.cacheVersion }, CMS_VERSION.schemaVersion));

  const credential = await credentialFor(store, identity, identifier);
  if (!credential || isDefaultAdminCredential(credential)) return refuse(false);
  failedUsername = credential.username;
  if (!(await verifyAdminLoginPassword(password, credential))) return refuse(true);

  await Promise.all([
    // The pair's current window, by its exact key (a LIKE pattern would read `_` in a username as a wildcard).
    platformDb.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`${pairKey(ip, identifier)}:${Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS}`).run(),
    clearAdminLoginFailures(store, credential.username, ip),
  ]);
  const now = (deps.now ?? (() => new Date()))();
  // T-57: an enrolled credential gets a challenge in its own store, never a handoff, until the code.
  if (await twoStepEnabled(store, credential.id)) {
    return { status: 202, challenge: await createLoginChallenge(store, { id: credential.id, updatedAt: credential.updatedAt }, now) };
  }
  return loginHandoff(platformDb, identity, credential, now);
}

async function loginHandoff(platformDb: D1Database, identity: ResolvedIdentity, credential: AdminCredential, now: Date): Promise<StoreLoginResult> {
  const token = await issueHandoff(platformDb, identity.tenantId, identity.host, "login", now, {
    id: credential.id,
    username: credential.username,
    updatedAt: credential.updatedAt,
  });
  return {
    status: 200,
    host: identity.host,
    token,
    next: credential.mustChangePassword ? "/admin/profile" : getDefaultAdminRoute(credential.role),
  };
}

/**
 * T-57, the second step on adsbook.id/masuk: the identifier again (it names the
 * store; the password is not sent twice), the challenge from the first step
 * and a code. The handoff is issued only for the exact credential revision the
 * password was checked against. Every attempt spends the address ceiling; a
 * wrong code spends the challenge and the credential's own failure budget.
 */
export async function storeLoginSecondStep(
  env: Record<string, unknown>,
  input: { identifier?: unknown; challenge?: unknown; code?: unknown },
  ip: string,
  deps: StoreLoginDeps = {},
): Promise<StoreLoginResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  if (!platformDb?.prepare) return { status: 503, error: "Masuk belum tersedia. Coba lagi beberapa saat lagi." };
  await ensureControlPlane(platformDb);
  const address = await checkRateLimit(platformDb, addressKey(ip), PLATFORM_LOGIN_LIMITS.perAddress, WINDOW_MS, true);
  if (!address.allowed) return { status: 429, error: LOGIN_RATE_LIMITED };
  const expired = { status: 401 as const, error: challengeRefusal("invalid") };
  const identifier = identityKey(input.identifier);
  const identity = identifier ? await resolvePlatformIdentity(platformDb, identifier) : null;
  if (!identity) return expired;
  const store = await (deps.openStore
    ? deps.openStore(identity.tenantId, identity.cacheVersion)
    : openTenantDb(env as TenantDbEnv, { tenantId: identity.tenantId, cacheVersion: identity.cacheVersion }, CMS_VERSION.schemaVersion));
  const credential = await credentialFor(store, identity, identifier);
  if (!credential || isDefaultAdminCredential(credential)) return expired;
  const now = (deps.now ?? (() => new Date()))();
  const outcome = await redeemLoginChallenge(store, input.challenge, typeof input.code === "string" ? input.code : "", now, credential.id);
  if (!outcome.ok) return { status: 401, error: challengeRefusal(outcome.reason) };
  if (outcome.credentialUpdatedAt !== credential.updatedAt) return expired;
  return loginHandoff(platformDb, identity, credential, now);
}
