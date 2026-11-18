/**
 * IAM-8 handoff tokens: how a response on the platform host gives the owner a
 * session on the seller host, which it cannot set a cookie for. 32 random
 * bytes, kept only as a SHA-256 in `PLATFORM_DB.handoff_tokens`, bound to one
 * tenant, one purpose and the tenant's platform subdomain, valid 10 minutes
 * (signup), 2 minutes (login, adsbook.id/masuk: it names the user it signs in)
 * or 24 hours (owner recovery), consumed atomically once. The token travels
 * only in a POST body (never a URL that is logged or cached).
 */
export type HandoffPurpose = "signup" | "owner_recovery" | "login";

const LIFETIME_MS: Record<HandoffPurpose, number> = {
  signup: 10 * 60 * 1000,
  owner_recovery: 24 * 60 * 60 * 1000,
  login: 2 * 60 * 1000,
};

const TOKEN = /^[0-9a-f]{64}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A non-secret id for one issued token: a prefix of its hash, for audit linkage. */
export async function handoffIssuanceId(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 16);
}

/**
 * The insert of a fresh token, for a caller that writes it in one batch with
 * its audit row (IAM-9 issuance). The token is returned once and never stored.
 */
export async function prepareHandoff(
  platformDb: D1Database,
  tenantId: string,
  host: string,
  purpose: HandoffPurpose,
  now = new Date(),
): Promise<{ token: string; issuance: string; statement: D1PreparedStatement; expiresAt: string }> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const hash = await sha256Hex(token);
  const expiresAt = new Date(now.getTime() + LIFETIME_MS[purpose]).toISOString();
  return {
    token,
    issuance: hash.slice(0, 16),
    expiresAt,
    statement: platformDb
      .prepare("INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(hash, tenantId, purpose, host, expiresAt),
  };
}

/** Whether a token would redeem now, without consuming it (validation before use). */
export async function peekHandoff(
  platformDb: D1Database,
  token: unknown,
  host: string,
  purpose: HandoffPurpose,
  now = new Date(),
): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const row = await platformDb
    .prepare("SELECT tenant_id FROM handoff_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND host = ? AND purpose = ?")
    .bind(await sha256Hex(token), now.toISOString(), host, purpose)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

/** The atomic single-use spend of a token, as a statement to batch with its audit row. */
export async function spendHandoff(
  platformDb: D1Database,
  token: string,
  host: string,
  purpose: HandoffPurpose,
  now = new Date(),
): Promise<D1PreparedStatement> {
  return platformDb
    .prepare("UPDATE handoff_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND host = ? AND purpose = ?")
    .bind(now.toISOString(), await sha256Hex(token), now.toISOString(), host, purpose);
}

export async function issueHandoff(
  platformDb: D1Database,
  tenantId: string,
  host: string,
  purpose: HandoffPurpose,
  now = new Date(),
  /** `login` only: the credential the session is for, owner or staff. */
  username: string | null = null,
): Promise<string> {
  if ((purpose === "login") !== Boolean(username)) throw new Error("a login handoff names its user; no other does");
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await platformDb
    .prepare("INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at, username) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), tenantId, purpose, host, new Date(now.getTime() + LIFETIME_MS[purpose]).toISOString(), username)
    .run();
  return token;
}

/**
 * Redeems a signup or login token for `host` in one statement: the tenant, the
 * purpose and, for a login, the user it was issued for; null for anything
 * unknown, used, expired or bound elsewhere. Owner recovery is never redeemed
 * here (it has its own form, `src/platform/admin/recovery.ts`).
 */
export async function consumeSessionHandoff(
  platformDb: D1Database,
  token: unknown,
  host: string,
  now = new Date(),
): Promise<{ tenantId: string; purpose: "signup" | "login"; username: string | null } | null> {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const row = await platformDb
    .prepare(
      `UPDATE handoff_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND host = ? AND purpose IN ('signup', 'login')
       RETURNING tenant_id, purpose, username`,
    )
    .bind(now.toISOString(), await sha256Hex(token), now.toISOString(), host)
    .first<{ tenant_id: string; purpose: "signup" | "login"; username: string | null }>();
  return row ? { tenantId: row.tenant_id, purpose: row.purpose, username: row.username } : null;
}

/**
 * Redeem a token for `host` and `purpose`: the tenant id it was issued for,
 * or null for an unknown, used, expired, wrong-host or wrong-purpose token.
 * One statement, so two redemptions of one token cannot both succeed.
 */
export async function consumeHandoff(
  platformDb: D1Database,
  token: unknown,
  host: string,
  purpose: HandoffPurpose,
  now = new Date(),
): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const row = await platformDb
    .prepare(
      `UPDATE handoff_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND host = ? AND purpose = ?
       RETURNING tenant_id`,
    )
    .bind(now.toISOString(), await sha256Hex(token), now.toISOString(), host, purpose)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

/**
 * IAM-5's one exception: the handoff form posts from a platform origin. The
 * Origin must be exactly one (`https://adsbook.id`, `https://app.adsbook.id`,
 * or a configured local platform host over http on `*.localhost`), and the
 * browser must call it cross-site — same-site only between two local
 * `*.localhost` hosts, which share a site.
 */
export function isPlatformHandoffOrigin(
  origin: string | null,
  fetchSite: string | null,
  platformHostSet: ReadonlySet<string>,
): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin || !platformHostSet.has(parsed.hostname)) return false;
  const local = parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost");
  if (!local) {
    // Production: exactly `https://<platform host>`, no port, and a cross-site call.
    return parsed.protocol === "https:" && parsed.port === "" && fetchSite === "cross-site";
  }
  // Local development only: `*.localhost` hosts share one site, on any port.
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && (fetchSite === "same-site" || fetchSite === "cross-site");
}

/** Where the Worker entry carries the handoff's real Origin past Astro's own check. */
export const HANDOFF_ORIGIN_HEADER = "x-adsbook-handoff-origin";
/** And its real `Sec-Fetch-Site`, which Astro reads first. */
export const HANDOFF_FETCH_SITE_HEADER = "x-adsbook-handoff-fetch-site";
export const HANDOFF_PATH = "/api/handoff";

/**
 * Astro refuses every cross-site form POST before middleware runs
 * (`security.checkOrigin`), and the IAM-8 handoff is exactly one. For this
 * one path only, the Worker entry moves the browser's `Origin` into
 * `HANDOFF_ORIGIN_HEADER` (dropping any copy the client sent) and presents
 * the request as same-origin to Astro; the route then applies the strict
 * IAM-5 exception to the real Origin. Every other path keeps Astro's check.
 */
export function prepareHandoffRequest(request: Request): Request {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== HANDOFF_PATH) return request;
  const headers = new Headers(request.headers);
  headers.delete(HANDOFF_ORIGIN_HEADER);
  headers.delete(HANDOFF_FETCH_SITE_HEADER);
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site");
  if (origin !== null) headers.set(HANDOFF_ORIGIN_HEADER, origin);
  if (site !== null) headers.set(HANDOFF_FETCH_SITE_HEADER, site);
  headers.set("origin", url.origin);
  headers.set("sec-fetch-site", "same-origin");
  return new Request(request, { headers });
}
