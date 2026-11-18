/**
 * adsbook.id/masuk (AUTH-LOGIN-REGISTER-UX-SPEC §1.3): one door for every
 * store. An email or username and a password; the store is found from the
 * identifier (`platform_identities`), the password is checked against that
 * store's own credential, and the answer is a short `login` handoff that the
 * browser posts to the store's subdomain, where the session is opened
 * (`/api/handoff`). No cookie is set on the platform host.
 *
 * Every refusal reads the same and costs about the same (LOGIN-13): an
 * unknown identifier, an inactive store, a missing or seeded credential and a
 * wrong password all run one PBKDF2 verification and answer one message.
 * Attempts are limited per address and per identifier on the platform, and
 * the store's own login lockout (the one /hello keeps) counts them too, so
 * alternating the two doors buys no extra guesses.
 */
import {
  DEFAULT_ADMIN_PASSWORD_HASH,
  getAdminCredential,
  isDefaultAdminCredential,
  verifyAdminLoginPassword,
} from "../lib/admin-credentials.ts";
import { getDefaultAdminRoute, secureEqual, verifyPasswordHash } from "../lib/auth.ts";
import {
  checkAdminLoginRateLimit,
  checkRateLimit,
  clearAdminLoginFailures,
  recordAdminLoginFailure,
  spendAdminLoginAttempt,
} from "../lib/rate-limit.ts";
import { CMS_VERSION } from "../lib/version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { issueHandoff } from "./handoff.ts";
import { identityKey, resolvePlatformIdentity } from "./identities.ts";
import { openTenantDb, type TenantDbEnv } from "./tenant-db.ts";

export const LOGIN_REFUSED = "Email/username atau password belum sesuai.";
export const LOGIN_RATE_LIMITED = "Terlalu banyak percobaan masuk. Coba lagi dalam beberapa menit.";
const WINDOW_MS = 10 * 60 * 1000;
export const PLATFORM_LOGIN_LIMITS = { perAddress: 20, perIdentifier: 8 } as const;

export type StoreLoginResult =
  | { status: 200; host: string; token: string; next: string }
  | { status: 401 | 429 | 503; error: string };

export type StoreLoginDeps = {
  now?: () => Date;
  /** Tests: the tenant store without a Durable Object namespace. */
  openStore?: (tenantId: string, cacheVersion: number) => Promise<D1Database>;
};

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

  // Before any lookup, so a known and an unknown identifier meet the same limits.
  const [address, perIdentifier] = await Promise.all([
    checkRateLimit(platformDb, `platform-login-ip:${ip}`, PLATFORM_LOGIN_LIMITS.perAddress, WINDOW_MS),
    checkRateLimit(platformDb, `platform-login-id:${identifier || "-"}`, PLATFORM_LOGIN_LIMITS.perIdentifier, WINDOW_MS),
  ]);
  if (!address.allowed || !perIdentifier.allowed) return { status: 429, error: LOGIN_RATE_LIMITED };

  const refuse = async (): Promise<StoreLoginResult> => {
    // The work floor: one discarded verification, as long as a real one.
    await verifyPasswordHash(password, DEFAULT_ADMIN_PASSWORD_HASH);
    return { status: 401, error: LOGIN_REFUSED };
  };
  if (!identifier || !password) return refuse();

  const identity = await resolvePlatformIdentity(platformDb, identifier);
  if (!identity) return refuse();
  const database = await (deps.openStore
    ? deps.openStore(identity.tenantId, identity.cacheVersion)
    : openTenantDb(env as TenantDbEnv, { tenantId: identity.tenantId, cacheVersion: identity.cacheVersion }, CMS_VERSION.schemaVersion));

  // A staff email signs in the staff member it belongs to; every other identifier is a username.
  const username = identity.kind === "staff_email"
    ? (await database.prepare("SELECT username FROM admin_credentials WHERE email = ? AND role <> 'owner' LIMIT 1").bind(identifier).first<{ username: string }>())?.username ?? identifier
    : identifier;

  // The store's own lockout, the one /hello keeps for this user.
  const wave = await spendAdminLoginAttempt(database, username, ip);
  const attempts = wave.allowed ? await checkAdminLoginRateLimit(database, username, ip) : wave;
  if (!attempts.allowed) return { status: 429, error: LOGIN_RATE_LIMITED };

  const credential = await getAdminCredential(database, username);
  if (!credential || isDefaultAdminCredential(credential)) {
    await recordAdminLoginFailure(database, username, ip);
    return refuse();
  }
  const [usernameMatches, passwordMatches] = await Promise.all([
    secureEqual(username, credential.username),
    verifyAdminLoginPassword(password, credential),
  ]);
  if (!usernameMatches || !passwordMatches) {
    await recordAdminLoginFailure(database, username, ip);
    return { status: 401, error: LOGIN_REFUSED };
  }

  await clearAdminLoginFailures(database, username, ip);
  const token = await issueHandoff(platformDb, identity.tenantId, identity.host, "login", (deps.now ?? (() => new Date()))(), credential.username);
  return {
    status: 200,
    host: identity.host,
    token,
    next: credential.mustChangePassword ? "/admin/profile" : getDefaultAdminRoute(credential.role),
  };
}
