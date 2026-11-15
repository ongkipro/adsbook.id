/**
 * The only way to the shared Cloudflare resources (TEN-3, MULTI-TENANT-DESIGN
 * §5). Every key carries the tenant:
 *
 * - R2 `ASSET_BUCKET`: `t/<tenantId>/<key>`. Public URLs stay tenant-relative
 *   (`/assets/uploads/…`, `/media/content/…`); the route adds the prefix, so no
 *   stored URL changes.
 * - KV `SESSION`: `t:<tenantId>:<key>` for a tenant, `p:<key>` for the
 *   platform. Caches only (ADR-021).
 * - Edge cache: `https://cache.adsbook.id/t/<tenantId>/v<cacheVersion>/<host><path>`.
 *   The version is bumped on suspend and on a hostname change, so an entry
 *   written before either is unreachable after it.
 *
 * Nothing outside this file names `ASSET_BUCKET` or `SESSION`
 * (`static-bans.test.ts`). A missing binding is `undefined`, never a throw:
 * every caller already treats storage and caches as optional.
 */

import type { R2Object, R2ObjectBody } from "@cloudflare/workers-types/index.ts";

/** Who a key belongs to: the gate's tenant (`locals.tenantContext`) or the cron's. */
export type TenantScope = { tenantId: string; cacheVersion: number };

type Bindings = { ASSET_BUCKET?: unknown; SESSION?: unknown } | null | undefined;

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkedTenant(tenantId: string): string {
  // A tenant id is a platform-issued slug-safe string; anything else would let
  // a crafted id climb out of its prefix (`t/../`), so it is refused outright.
  if (!TENANT_ID.test(tenantId)) throw new Error("invalid tenant id for a shared-resource key");
  return tenantId;
}

/** R2 object key for a tenant-relative key; refuses traversal and absolute keys. */
export function tenantR2Key(tenantId: string, key: string): string {
  if (!key || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("invalid object key");
  }
  return `t/${checkedTenant(tenantId)}/${key}`;
}

export type TenantBucket = {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: Parameters<R2Bucket["put"]>[1],
    options?: Parameters<R2Bucket["put"]>[2],
  ): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
};

/** The tenant's view of `ASSET_BUCKET`, or undefined when the binding is absent. */
export function tenantR2(env: Bindings, tenantId: string): TenantBucket | undefined {
  const bucket = env?.ASSET_BUCKET as R2Bucket | undefined;
  if (!bucket || typeof bucket !== "object") return undefined;
  checkedTenant(tenantId);
  return {
    get: (key) => bucket.get(tenantR2Key(tenantId, key)),
    put: (key, value, options) => bucket.put(tenantR2Key(tenantId, key), value, options),
    delete: (key) => bucket.delete(tenantR2Key(tenantId, key)),
  };
}

/** The KV calls the code base makes: JSON or text reads, writes with a TTL, deletes. */
export type ScopedKv = {
  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

function prefixedKv(env: Bindings, prefix: string): ScopedKv | undefined {
  const kv = env?.SESSION as KVNamespace | undefined;
  if (!kv || typeof kv !== "object") return undefined;
  return {
    get: ((key: string, type?: "json") =>
      type === "json" ? kv.get(prefix + key, "json") : kv.get(prefix + key)) as ScopedKv["get"],
    put: (key, value, options) => kv.put(prefix + key, value, options),
    delete: (key) => kv.delete(prefix + key),
  };
}

export function tenantKvKey(tenantId: string, key: string): string {
  return `t:${checkedTenant(tenantId)}:${key}`;
}

/** The tenant's view of `SESSION`: every key `t:<tenantId>:…`. */
export function tenantKv(env: Bindings, tenantId: string): ScopedKv | undefined {
  return prefixedKv(env, tenantKvKey(tenantId, ""));
}

/** The platform's own KV keys, `p:…`; never a tenant's data. */
export function platformKv(env: Bindings): ScopedKv | undefined {
  return prefixedKv(env, "p:");
}

/** The synthetic origin every edge-cache key lives under; never a real host. */
export const EDGE_CACHE_ORIGIN = "https://cache.adsbook.id";

/**
 * The edge-cache key for a request already resolved to `tenant`: the tenant,
 * its cache version, the host and the path, plus whatever query the caller
 * kept. Two tenants never share a key, and a host moved from one tenant to
 * another starts from an empty cache.
 */
export function tenantCacheKey(tenant: TenantScope, host: string, pathAndQuery: string): string {
  const version = Number.isSafeInteger(tenant.cacheVersion) ? tenant.cacheVersion : 0;
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${EDGE_CACHE_ORIGIN}/t/${checkedTenant(tenant.tenantId)}/v${version}/${host.toLowerCase()}${path}`;
}

/** Locals carry the gate's tenant; a request without one has no shared resource. */
export function scopeFromLocals(
  locals: { tenantContext?: { tenantId: string; cacheVersion: number } } | null | undefined,
): TenantScope | undefined {
  const context = locals?.tenantContext;
  return context ? { tenantId: context.tenantId, cacheVersion: context.cacheVersion } : undefined;
}
