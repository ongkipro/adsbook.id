/**
 * Per-tenant webhook tokens (SEC-5, API-7, T-23). A provider calls
 * `https://<slug>.adsbook.my.id/api/webhooks/<provider>/<token>`; the token is
 * 256 random bits shown to the owner once, and only its SHA-256 is kept in
 * `PLATFORM_DB.webhook_secrets`. The token is a path segment, so request URLs
 * are never logged (OBS-1 logs the route pattern only).
 *
 * A webhook is accepted only when all three hold, checked before any write:
 * the host is the tenant's own platform subdomain (never a custom domain,
 * whose ownership can move), a token is stored for that tenant and provider,
 * and the presented token hashes to it (constant-time compare).
 */
import type { TenantContext } from "./control-plane.ts";

export const WEBHOOK_PROVIDERS = ["autolaris", "mengantar"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

const TOKEN = /^[0-9a-f]{64}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

/**
 * Issue (or rotate) the tenant's token for `provider`; returns the plain token
 * once. The previous token stops working at once.
 */
export async function issueWebhookToken(
  platformDb: D1Database,
  tenantId: string,
  provider: WebhookProvider,
  now = new Date(),
): Promise<string> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await platformDb
    .prepare(
      `INSERT INTO webhook_secrets (tenant_id, provider, secret_hash, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET secret_hash = excluded.secret_hash, created_at = excluded.created_at`,
    )
    .bind(tenantId, provider, await sha256Hex(token), now.toISOString())
    .run();
  return token;
}

/** When the tenant's token for `provider` was issued, or null when none is. */
export async function webhookTokenIssuedAt(
  platformDb: D1Database,
  tenantId: string,
  provider: WebhookProvider,
): Promise<string | null> {
  const row = await platformDb
    .prepare("SELECT created_at FROM webhook_secrets WHERE tenant_id = ? AND provider = ?")
    .bind(tenantId, provider)
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

export type WebhookVerdict = "accepted" | "not_found" | "unauthorized";

/**
 * Whether this request may write: `not_found` for any host but the tenant's
 * platform subdomain, `unauthorized` for a missing, malformed or wrong token.
 */
export async function verifyWebhook(
  platformDb: D1Database | undefined,
  tenant: Pick<TenantContext, "tenantId" | "hostKind"> | undefined,
  provider: WebhookProvider,
  token: string | undefined,
): Promise<WebhookVerdict> {
  if (!tenant || tenant.hostKind !== "subdomain") return "not_found";
  if (!platformDb || !token || !TOKEN.test(token)) return "unauthorized";
  const row = await platformDb
    .prepare("SELECT secret_hash FROM webhook_secrets WHERE tenant_id = ? AND provider = ?")
    .bind(tenant.tenantId, provider)
    .first<{ secret_hash: string }>();
  if (!row) return "unauthorized";
  return constantTimeEqual(await sha256Hex(token), row.secret_hash) ? "accepted" : "unauthorized";
}

/**
 * The URL to give the provider: the tenant's own platform subdomain (never a
 * custom domain), or null when the tenant has no active one.
 */
export async function webhookUrl(
  platformDb: D1Database,
  tenantId: string,
  provider: WebhookProvider,
  token: string,
): Promise<string | null> {
  const row = await platformDb
    .prepare("SELECT host FROM tenant_hosts WHERE tenant_id = ? AND kind = 'subdomain' AND status = 'active' LIMIT 1")
    .bind(tenantId)
    .first<{ host: string }>();
  return row ? `https://${row.host}/api/webhooks/${provider}/${token}` : null;
}
