/**
 * The control plane (`PLATFORM_DB`, TD-2): its schema and the authoritative
 * host → tenant read the gate makes on every tenant request.
 */
import { ensureSchemaUpgraded, type MigrationSource } from "../lib/schema-version.ts";

/** Files in `src/platform/migrations/`. Bump with every new control-plane file. */
export const PLATFORM_SCHEMA_VERSION = 5;

async function bundledPlatformMigrations(): Promise<readonly MigrationSource[]> {
  const { PLATFORM_MIGRATIONS } = await import("./bundled-migrations.ts");
  return PLATFORM_MIGRATIONS;
}

/**
 * Applies the control-plane chain once per isolate (the same runner and
 * ledger shape as tenant data, against `PLATFORM_DB`). A failure is not cached:
 * the next request tries again.
 */
export async function ensureControlPlane(
  db: D1Database,
  migrations?: readonly MigrationSource[],
): Promise<void> {
  await ensureSchemaUpgraded(db, {
    migrations: migrations ?? (await bundledPlatformMigrations()),
    expected: PLATFORM_SCHEMA_VERSION,
    cache: true,
  });
}

export type TenantStatus = "provisioning" | "active" | "suspended" | "recovery" | "purging" | "purged";

/** What a request on a tenant host knows about its tenant, for this request only. */
export type TenantContext = {
  tenantId: string;
  slug: string;
  status: TenantStatus;
  cacheVersion: number;
  host: string;
  /** `subdomain` is the tenant's immutable `<slug>.adsbook.cc`; webhooks answer only there (SEC-5). */
  hostKind: "subdomain" | "custom";
  primaryHost: string | null;
  /** PR-26: the one display-only demo store (`src/platform/demo.ts`). */
  isDemo?: boolean;
};

export type HostResolution =
  | { kind: "tenant"; tenant: TenantContext }
  | { kind: "not-found" }
  | { kind: "suspended" }
  | { kind: "recovery" };

type HostRow = {
  host_status: string;
  host_kind?: string;
  quarantine_until: string | null;
  tenant_id: string;
  slug: string;
  status: TenantStatus;
  cache_version: number;
  primary_host: string | null;
  is_demo?: number | null;
};

const HOST_SQL = `SELECT h.status AS host_status, h.kind AS host_kind, h.quarantine_until,
    t.id AS tenant_id, t.slug, t.status, t.cache_version, t.is_demo,
    (SELECT p.host FROM tenant_hosts p
      WHERE p.tenant_id = t.id AND p.is_primary = 1 AND p.status = 'active') AS primary_host
  FROM tenant_hosts h JOIN tenants t ON t.id = h.tenant_id
  WHERE h.host = ?`;

/** DOM-2 and §2 step 5 of 08-DOMAIN-ROUTING: one decision per row state. */
export function decideHost(row: HostRow | null, host: string, now: Date): HostResolution {
  if (!row || row.host_status !== "active") return { kind: "not-found" };
  if (row.quarantine_until && Date.parse(row.quarantine_until) > now.getTime()) return { kind: "not-found" };
  switch (row.status) {
    case "active":
      return {
        kind: "tenant",
        tenant: {
          tenantId: row.tenant_id,
          slug: row.slug,
          status: row.status,
          cacheVersion: Number(row.cache_version),
          host,
          hostKind: row.host_kind === "subdomain" ? "subdomain" : "custom",
          primaryHost: row.primary_host,
          isDemo: Number(row.is_demo) === 1,
        },
      };
    case "suspended":
      return { kind: "suspended" };
    case "recovery":
      return { kind: "recovery" };
    default:
      // provisioning, purging, purged: never routable.
      return { kind: "not-found" };
  }
}

/**
 * The in-isolate cache of `MULTI-TENANT-DESIGN.md` §3: memory only, never KV,
 * and **misses only**. An active host is read from `PLATFORM_DB` on every
 * request, so a suspension, revocation or move takes effect on the next
 * request in every isolate (T-17 review P1); a cached miss only delays a newly
 * activated host by `ttlMs`, which is harmless. Bounded so a random-Host flood
 * cannot grow it without limit.
 */
export class HostCache {
  readonly #entries = new Map<string, { at: number; value: HostResolution }>();
  readonly ttlMs: number;
  readonly maxEntries: number;

  constructor(ttlMs = HOST_CACHE_TTL_MS, maxEntries = 1000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(host: string, now: number): HostResolution | undefined {
    const entry = this.#entries.get(host);
    if (!entry) return undefined;
    if (now - entry.at >= this.ttlMs) {
      this.#entries.delete(host);
      return undefined;
    }
    return entry.value;
  }

  set(host: string, value: HostResolution, now: number): void {
    if (value.kind !== "not-found") return;
    if (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(host, { at: now, value });
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** In-isolate TTL of a cached miss (SPIKE-1 item 7). */
export const HOST_CACHE_TTL_MS = 5_000;
/**
 * DOM-3 quarantine for a moved host. With no positive cache the quarantine no
 * longer covers a stale isolate entry; it keeps a moved host unroutable while
 * any D1 read replica may still return the old row.
 */
export const HOST_QUARANTINE_MS = 60_000;

/** One per isolate: module scope is the intended lifetime of this cache. */
const isolateHostCache = new HostCache();

/** The authoritative read (one primary-key lookup), behind the in-isolate cache. */
export async function resolveTenantHost(
  db: D1Database,
  host: string,
  now = new Date(),
  cache: HostCache = isolateHostCache,
): Promise<HostResolution> {
  const cached = cache.get(host, now.getTime());
  if (cached) return cached;
  const row = await db.prepare(HOST_SQL).bind(host).first<HostRow>();
  const resolution = decideHost(row, host, now);
  cache.set(host, resolution, now.getTime());
  return resolution;
}
