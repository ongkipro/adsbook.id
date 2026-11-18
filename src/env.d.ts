/// <reference path="../.astro/types.d.ts" />
/// <reference types="@astrojs/cloudflare" />
type KVNamespace = import("@cloudflare/workers-types/index.ts").KVNamespace;
type D1Database = import("@cloudflare/workers-types/index.ts").D1Database;
type D1PreparedStatement =
  import("@cloudflare/workers-types/index.ts").D1PreparedStatement;
type D1Result<T = unknown> =
  import("@cloudflare/workers-types/index.ts").D1Result<T>;
type R2Bucket = import("@cloudflare/workers-types/index.ts").R2Bucket;
type Ai = import("@cloudflare/workers-types/index.ts").Ai;

interface SharedEnvVars {
  // No store identity, AUTH_SECRET, INSTALL_TOKEN (T-21) or provider credential
  // (T-45) here: each is a row in the tenant's own store.
  /** The platform's HTTPS endpoint for redacted operational alerts (a Worker secret). */
  OPS_ALERT_WEBHOOK_URL?: string;
  /** Operator notices (T-44, PR-29): new seller, store ready, domain active/failing, first order. A Worker secret. */
  PLATFORM_ALERT_WEBHOOK_URL?: string;
  /**
   * ADR-040 (T-48): the root of stored provider-credential encryption, 32 random
   * bytes as base64, optionally `v<N>:`-prefixed. A Worker secret; without it no
   * credential is read or stored. `_PREVIOUS` holds the prior key during rotation.
   */
  PLATFORM_CREDENTIAL_KEY?: string;
  PLATFORM_CREDENTIAL_KEY_PREVIOUS?: string;
  /** The platform admin origin for links in notices (default https://app.adsbook.id). */
  PLATFORM_ADMIN_URL?: string;
  /** The marketing site (T-40): canonical origin, the platform's own Pixel and CAPI token (secret), support contacts. */
  PLATFORM_SITE_URL?: string;
  PLATFORM_META_PIXEL_ID?: string;
  PLATFORM_META_CAPI_TOKEN?: string;
  PLATFORM_META_TEST_EVENT_CODE?: string;
  PLATFORM_SUPPORT_EMAIL?: string;
  PLATFORM_SUPPORT_WHATSAPP?: string;
  /** Cloudflare for SaaS (T-25): the SaaS zone id and a zone-scoped "SSL and Certificates Write" token. */
  CF_SAAS_ZONE_ID?: string;
  CF_SAAS_TOKEN?: string;
  /** Local development only: a stand-in for api.cloudflare.com. */
  CF_API_BASE?: string;
  /** Signup's Turnstile (T-26): the public site key and the Worker secret. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Local development only: a stand-in for Turnstile's siteverify. */
  TURNSTILE_VERIFY_URL?: string;
  /** Platform admin sessions (IAM-3), 32+ characters. */
  PLATFORM_AUTH_SECRET?: string;
  /** Local development only: seller hosts under `localhost` instead of `adsbook.my.id`. */
  TENANT_HOST_SUFFIX?: string;
}

interface CloudflareRuntimeEnv extends SharedEnvVars {
  SESSION: KVNamespace;
  ASSET_BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: unknown;
  /** The control plane (TD-2): tenants, hosts, plans, audit. */
  PLATFORM_DB?: D1Database;
  /** Private bucket for the daily `PLATFORM_DB` snapshot (T-30); only `src/platform/backup.ts` writes it. */
  BACKUP_BUCKET?: R2Bucket;
  /** One SQLite Durable Object per tenant (TD-3); only `src/platform/` reaches it. */
  TENANT_STORE?: unknown;
  /** Extra exact platform hosts for local development, comma separated. */
  PLATFORM_HOSTS?: string;
}
declare namespace Cloudflare {
  interface Env extends CloudflareRuntimeEnv {}
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}


declare namespace App {
  interface Locals {
    runtimeEnv?: CloudflareRuntimeEnv | Record<string, unknown>;
    /**
     * Store identity, resolved once per request in middleware from the `stores`
     * row with environment fallback. Read this instead of importing a
     * build-time constant — see DECISIONS.md ADR-003.
     */
    tenant: import("./lib/tenant").PublicTenantConfig;
    admin?: {
      username: string;
      role: import("./lib/auth").AdminRole;
      mustChangePassword: boolean;
    };
    /**
     * Set by the request gate (TD-1) on a tenant host only: the tenant this
     * request belongs to, resolved from `Host` against `PLATFORM_DB`.
     */
    tenantContext?: import("./platform/control-plane").TenantContext;
    /**
     * ADR-041: the store's subscription state (absent for the demo store and
     * platform hosts). `adSignalsPaused` empties the ads config on public
     * requests, so no pixel, tag or browser event leaves a store that is not live.
     */
    billing?: { state: import("./platform/billing").BillingState; adSignalsPaused: boolean };
    /**
     * PR-23: set when the signed-in owner views their store before it is
     * ready; buyers get the "Toko belum siap" page instead. BaseLayout shows
     * an owner-preview bar; the answer is private and never edge-cached.
     */
    ownerPreview?: boolean;
    /**
     * This tenant's database (TEN-2): opened by the middleware from
     * `tenantContext.tenantId` through `src/platform/tenant-db.ts`. Read it
     * through `tenantDatabase(locals)` (`src/lib/tenant-database.ts`).
     */
    tenantDb?: D1Database;
    /** Set by the request gate on a platform host only; never with `tenantContext`. */
    platform?: { host: string };
    /** The signed-in platform user on a platform host (T-27); never on a seller host. */
    platformUser?: import("./platform/admin/session").PlatformUser;
  }
}
