/**
 * Custom hostnames through the Cloudflare for SaaS API (T-25), the lifecycle
 * of `docs/spec/08-DOMAIN-ROUTING.md` §4:
 *
 * claim → create at Cloudflare → seller points DNS → re-check → activate
 * routing only when `status` and `ssl.status` are both `active` (DOM-4) →
 * HTTPS probe → may become primary. Removal deletes the Cloudflare hostname
 * (DOM-5); a pending one is reaped after 7 days (src/platform/jobs.ts).
 *
 * The zone name, the platform domain, their subdomains and hosts over 64
 * characters are refused before any API call (HOST-4). `tenant_hosts.host` is
 * the primary key, so of two tenants claiming one host exactly one wins
 * (DATA-6, HOST-2). Only a `pending` row is ever promoted to `active`, which
 * is what lets the reaper claim a row safely.
 */
import { normalizeHost } from "./host.ts";

export const SELLER_ZONE = "belanja.cc";
export const PLATFORM_DOMAIN = "adsbook.id";
export const CNAME_TARGET = `cname.${SELLER_ZONE}`;
/** Certificate Common Name limit; Cloudflare refuses longer hosts (error 1469). */
export const MAX_HOST_LENGTH = 64;
/** DOM-3: a removed host is unroutable for this long before anyone may claim it. */
export const QUARANTINE_MS = 60_000;

export type ClaimMode = "root" | "www" | "subdomain";

export type CfHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; method?: string; validation_errors?: Array<{ message?: string }> };
  verification_errors?: string[];
};

export interface CustomHostnameApi {
  create(hostname: string): Promise<CfHostname>;
  get(id: string): Promise<CfHostname>;
  /** A PATCH with the same `ssl` method and type restarts validation. */
  recheck(id: string): Promise<CfHostname>;
  /** Cleanup after a create whose answer was lost (timeout): look it up by name. */
  findByHostname(hostname: string): Promise<CfHostname | null>;
  remove(id: string): Promise<void>;
}

export class CloudflareApiError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "CloudflareApiError";
    this.code = code;
  }
}

const SSL = { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } as const;

/**
 * The real client. `base` is Cloudflare's API unless a local stand-in is
 * configured (dev only). The token is the zone-scoped `CF_SAAS_TOKEN`.
 */
export function cloudflareHostnameApi(options: {
  zoneId: string;
  token: string;
  base?: string;
  fetcher?: typeof fetch;
}): CustomHostnameApi {
  const base = (options.base ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;
  const call = async <T = CfHostname>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetcher(`${base}/zones/${encodeURIComponent(options.zoneId)}/custom_hostnames${path}`, {
      method,
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => null)) as
      | { success?: boolean; result?: CfHostname; errors?: Array<{ code?: number; message?: string }> }
      | null;
    if (!response.ok || !payload?.success) {
      const error = payload?.errors?.[0];
      throw new CloudflareApiError(error?.message || `Cloudflare HTTP ${response.status}`, error?.code ?? null);
    }
    return payload.result as T;
  };
  return {
    create: (hostname) => call("POST", "", { hostname, ssl: SSL }),
    get: (id) => call("GET", `/${encodeURIComponent(id)}`),
    recheck: (id) => call("PATCH", `/${encodeURIComponent(id)}`, { ssl: SSL }),
    findByHostname: async (hostname) =>
      (await call<CfHostname[]>("GET", `?hostname=${encodeURIComponent(hostname)}`)).find((entry) => entry.hostname === hostname) ?? null,
    remove: async (id) => {
      await call("DELETE", `/${encodeURIComponent(id)}`).catch((error) => {
        // Already gone is the outcome a delete wants.
        if (error instanceof CloudflareApiError && /not found/i.test(error.message)) return;
        throw error;
      });
    },
  };
}

/** The platform's client from its secrets, or undefined when they are not set. */
export function hostnameApiFromEnv(env: Record<string, unknown> | null | undefined): CustomHostnameApi | undefined {
  const zoneId = typeof env?.CF_SAAS_ZONE_ID === "string" ? env.CF_SAAS_ZONE_ID.trim() : "";
  const token = typeof env?.CF_SAAS_TOKEN === "string" ? env.CF_SAAS_TOKEN.trim() : "";
  if (!zoneId || !token) return undefined;
  const base = typeof env?.CF_API_BASE === "string" && env.CF_API_BASE.trim() ? env.CF_API_BASE.trim() : undefined;
  return cloudflareHostnameApi({ zoneId, token, base });
}

/** A Cloudflare hostname whose id was never learned: resolved by name when deleted. */
export const LOOKUP_REF = "lookup:";

/**
 * Delete what a stored reference names: a Cloudflare id, or a `lookup:<host>`
 * left by a claim whose create answer was lost. Throws when Cloudflare cannot
 * confirm, so the caller keeps the reference for the next run.
 */
export async function deleteHostnameRef(api: CustomHostnameApi, reference: string): Promise<void> {
  if (!reference.startsWith(LOOKUP_REF)) return api.remove(reference);
  const found = await api.findByHostname(reference.slice(LOOKUP_REF.length));
  if (found) await api.remove(found.id);
}

const isWithin = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * HOST-4: the hosts a claim would create, or why it is refused — decided
 * before any API call. `root` creates the apex and `www`; `www` only `www`;
 * `subdomain` the host as typed. Each claim is one domain against the cap.
 */
export function planClaim(raw: unknown, mode: ClaimMode):
  | { ok: true; group: string; hosts: string[] }
  | { ok: false; error: string } {
  const typed = normalizeHost(typeof raw === "string" ? raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : "");
  if (!typed || !typed.includes(".")) return { ok: false, error: "Nama domain tidak valid." };
  const base = mode === "subdomain" ? typed : typed.replace(/^www\./, "");
  const hosts = mode === "root" ? [base, `www.${base}`] : mode === "www" ? [`www.${base}`] : [base];
  for (const host of hosts) {
    if (isWithin(host, SELLER_ZONE) || isWithin(host, PLATFORM_DOMAIN)) {
      return { ok: false, error: `Domain ${host} milik platform dan tidak bisa dipakai.` };
    }
    if (host.length > MAX_HOST_LENGTH) {
      return { ok: false, error: `Domain ${host} lebih dari ${MAX_HOST_LENGTH} karakter.` };
    }
  }
  return { ok: true, group: base, hosts };
}

export type DomainView = {
  host: string;
  kind: "subdomain" | "custom";
  group: string | null;
  status: string;
  sslStatus: string | null;
  isPrimary: boolean;
  /** Human-readable, in the merchant's language (API-5). */
  errors: string[];
  cnameTarget: string;
};

/** Cloudflare's validation messages, in Indonesian with the remedy (§4 Remedies). */
export function explainValidationErrors(hostname: CfHostname | null | undefined): string[] {
  if (!hostname) return [];
  const messages = [
    ...(hostname.verification_errors ?? []),
    ...(hostname.ssl?.validation_errors ?? []).map((error) => error.message ?? ""),
  ].filter(Boolean);
  return [...new Set(messages)].map((message) => {
    if (/cname to this zone|does not cname|not.*point/i.test(message)) {
      return `DNS belum mengarah ke ${CNAME_TARGET}. Tambahkan record CNAME (atau ALIAS untuk domain utama) lalu klik "Cek lagi".`;
    }
    if (/caa/i.test(message)) {
      return "Record CAA domain menolak penerbit sertifikat. Izinkan pki.goog dan letsencrypt.org di CAA, atau hapus CAA yang membatasi.";
    }
    if (/blocked|hold/i.test(message)) {
      return "Domain ditahan di Cloudflare. Lepas zone hold di akun Cloudflare Anda, lalu klik \"Cek lagi\".";
    }
    return `Cloudflare: ${message}`;
  });
}

type HostRow = {
  host: string;
  kind: "subdomain" | "custom";
  domain_group: string | null;
  status: string;
  ssl_status: string | null;
  is_primary: number;
  cf_custom_hostname_id: string | null;
};

const view = (row: HostRow, errors: string[] = []): DomainView => ({
  host: row.host,
  kind: row.kind,
  group: row.domain_group,
  status: row.status,
  sslStatus: row.ssl_status,
  isPrimary: row.is_primary === 1,
  errors,
  cnameTarget: CNAME_TARGET,
});

export async function listDomains(platformDb: D1Database, tenantId: string): Promise<DomainView[]> {
  const rows = (
    await platformDb
      .prepare(
        `SELECT host, kind, domain_group, status, ssl_status, is_primary, cf_custom_hostname_id FROM tenant_hosts
         WHERE tenant_id = ? AND status != 'revoked' ORDER BY kind DESC, created_at, host`,
      )
      .bind(tenantId)
      .all<HostRow>()
  ).results;
  return rows.map((row) => view(row));
}

export type DomainResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

async function bumpCacheVersion(platformDb: D1Database, tenantId: string) {
  return platformDb.prepare("UPDATE tenants SET cache_version = cache_version + 1 WHERE id = ?").bind(tenantId);
}

/** Claim, check the plan cap, save `pending` rows, then create them at Cloudflare. */
export async function claimDomain(
  platformDb: D1Database,
  api: CustomHostnameApi,
  tenantId: string,
  raw: unknown,
  mode: ClaimMode,
  now = new Date(),
): Promise<DomainResult<DomainView[]>> {
  const plan = planClaim(raw, mode);
  if (!plan.ok) return { ok: false, status: 422, error: plan.error };

  const cap = await platformDb
    .prepare(
      `SELECT p.max_custom_domains AS cap,
         (SELECT COUNT(DISTINCT h.domain_group) FROM tenant_hosts h
           WHERE h.tenant_id = t.id AND h.kind = 'custom' AND h.status != 'revoked') AS used
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?`,
    )
    .bind(tenantId)
    .first<{ cap: number; used: number }>();
  if (!cap) return { ok: false, status: 404, error: "Toko tidak ditemukan." };
  if (Number(cap.used) >= Number(cap.cap)) {
    return { ok: false, status: 409, error: `Batas paket tercapai: maksimal ${cap.cap} domain sendiri.` };
  }

  // DOM-3: a recently removed host stays unclaimable until its quarantine ends.
  const quarantined = await platformDb
    .prepare(
      `SELECT host FROM tenant_hosts WHERE host IN (${plan.hosts.map(() => "?").join(", ")})
       AND status = 'revoked' AND quarantine_until > ?`,
    )
    .bind(...plan.hosts, now.toISOString())
    .first<{ host: string }>();
  if (quarantined) return { ok: false, status: 409, error: `Domain ${quarantined.host} baru dilepas; coba lagi sebentar.` };

  let inserted: D1Result[];
  try {
    // One transaction (D1 batch): a revoked row is replaced only once its
    // quarantine has ended and Cloudflare no longer holds it; anyone else's
    // live row wins on the primary key (DATA-6); and each insert re-checks the
    // plan cap inside the same transaction, so two concurrent claims for
    // different domains cannot both pass it. Both inserts share the
    // condition, so a root claim lands whole or not at all.
    inserted = await platformDb.batch([
      ...plan.hosts.map((host) =>
        platformDb
          .prepare(
            `DELETE FROM tenant_hosts WHERE host = ? AND status = 'revoked' AND cf_custom_hostname_id IS NULL
             AND (quarantine_until IS NULL OR quarantine_until <= ?)`,
          )
          .bind(host, now.toISOString()),
      ),
      ...plan.hosts.map((host) =>
        platformDb
          .prepare(
            `INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at)
             SELECT ?, ?, 'custom', ?, 'pending', 0, ?
             WHERE (SELECT COUNT(DISTINCT domain_group) FROM tenant_hosts
                    WHERE tenant_id = ? AND kind = 'custom' AND status != 'revoked' AND domain_group != ?)
                 < (SELECT p.max_custom_domains FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ?)`,
          )
          .bind(host, tenantId, plan.group, now.toISOString(), tenantId, plan.group, tenantId),
      ),
    ]);
  } catch (error) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(error))) {
      return { ok: false, status: 409, error: "Domain ini sudah dipakai toko lain atau sudah ditambahkan." };
    }
    console.error("hostname-claim-reserve-failed", { group: plan.group, error: String(error) });
    return { ok: false, status: 500, error: "Domain belum bisa ditambahkan. Coba lagi beberapa saat lagi." };
  }
  if (inserted.slice(plan.hosts.length).some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    return { ok: false, status: 409, error: `Batas paket tercapai: maksimal ${cap.cap} domain sendiri.` };
  }

  /** What Cloudflare holds for this claim, kept in memory: a lost D1 write must not lose it. */
  const created = new Map<string, string>();
  try {
    const results: CfHostname[] = [];
    for (const host of plan.hosts) {
      const result = await api.create(host);
      created.set(host, result.id);
      results.push(result);
    }
    // All ids written together, only once every create succeeded: until then a
    // row has no Cloudflare id, so nothing can refresh or activate it mid-claim.
    const written = await platformDb.batch(
      results.map((result, index) =>
        platformDb
          .prepare("UPDATE tenant_hosts SET cf_custom_hostname_id = ?, ssl_status = ? WHERE host = ? AND tenant_id = ? AND status = 'pending'")
          .bind(result.id, result.ssl?.status ?? null, plan.hosts[index], tenantId),
      ),
    );
    // A row removed while Cloudflare was creating it: undo the whole claim.
    if (written.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error("claim rows changed during creation");
    }
  } catch (error) {
    // Nothing half-made stays routable. A hostname Cloudflare already holds is
    // deleted there; if that delete fails too, its row is kept `revoked` with
    // its Cloudflare id, so the platform job retries it (it bills until then).
    console.error("hostname-claim-failed", { group: plan.group, error: String(error) });
    for (const host of plan.hosts) {
      // The id Cloudflare gave us, or — when the create's answer was lost — a
      // lookup by name. `undefined` means unknown: the row is then kept, never
      // dropped on the guess that nothing exists.
      let id: string | null | undefined = created.get(host);
      if (id === undefined) {
        id = await api.findByHostname(host).then((found) => found?.id ?? null, () => undefined);
      }
      const release = id === null || (typeof id === "string" && (await api.remove(id).then(() => true, () => false)));
      // An unknown id is kept as a `lookup:` reference: it blocks any re-claim
      // and the platform job resolves and deletes it (deleteHostnameRef).
      const reference = typeof id === "string" ? id : `${LOOKUP_REF}${host}`;
      await platformDb
        .prepare(
          release
            ? "DELETE FROM tenant_hosts WHERE host = ? AND tenant_id = ? AND status = 'pending'"
            // Also a row a concurrent removal already revoked: it must still
            // carry the reference, or the reaper never sees the hostname.
            : `UPDATE tenant_hosts SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), cf_custom_hostname_id = ?
               WHERE host = ? AND tenant_id = ? AND status IN ('pending', 'revoked')
                 AND (cf_custom_hostname_id IS NULL OR cf_custom_hostname_id = ?)`,
        )
        .bind(...(release ? [host, tenantId] : [now.toISOString(), reference, host, tenantId, reference]))
        .run()
        .catch((cleanup) => console.error("hostname-claim-cleanup-failed", { host, cf: id ?? null, error: String(cleanup) }));
    }
    return {
      ok: false,
      status: 502,
      error: error instanceof CloudflareApiError
        ? `Cloudflare menolak domain ini: ${error.message}`
        : "Domain belum bisa ditambahkan. Coba lagi beberapa saat lagi.",
    };
  }
  return { ok: true, value: (await listDomains(platformDb, tenantId)).filter((domain) => domain.group === plan.group) };
}

async function ownedRow(platformDb: D1Database, tenantId: string, host: string): Promise<HostRow | null> {
  return platformDb
    .prepare(
      `SELECT host, kind, domain_group, status, ssl_status, is_primary, cf_custom_hostname_id FROM tenant_hosts
       WHERE host = ? AND tenant_id = ? AND status != 'revoked'`,
    )
    .bind(host, tenantId)
    .first<HostRow>();
}

/**
 * Read Cloudflare's state (or restart validation first) and activate routing
 * only when both states are `active` (DOM-4). Only a `pending` row is promoted.
 */
export async function refreshDomain(
  platformDb: D1Database,
  api: CustomHostnameApi,
  tenantId: string,
  rawHost: string,
  options: { recheck?: boolean } = {},
): Promise<DomainResult<DomainView>> {
  const host = normalizeHost(rawHost);
  const row = host ? await ownedRow(platformDb, tenantId, host) : null;
  if (!row || row.kind !== "custom" || !row.cf_custom_hostname_id) {
    return { ok: false, status: 404, error: "Domain tidak ditemukan di toko ini." };
  }
  let state: CfHostname;
  try {
    state = options.recheck ? await api.recheck(row.cf_custom_hostname_id) : await api.get(row.cf_custom_hostname_id);
  } catch (error) {
    console.error("hostname-refresh-failed", { host: row.host, error: String(error) });
    return { ok: false, status: 502, error: "Cloudflare tidak bisa dihubungi. Coba lagi beberapa saat lagi." };
  }
  const sslStatus = state.ssl?.status ?? null;
  const ready = state.status === "active" && sslStatus === "active";
  if (ready && row.status === "pending") {
    await platformDb.batch([
      platformDb
        .prepare("UPDATE tenant_hosts SET status = 'active', ssl_status = ? WHERE host = ? AND tenant_id = ? AND status = 'pending'")
        .bind(sslStatus, row.host, tenantId),
      await bumpCacheVersion(platformDb, tenantId),
    ]);
  } else {
    await platformDb
      .prepare("UPDATE tenant_hosts SET ssl_status = ? WHERE host = ? AND tenant_id = ?")
      .bind(sslStatus, row.host, tenantId)
      .run();
  }
  const fresh = await ownedRow(platformDb, tenantId, row.host);
  return { ok: true, value: view(fresh ?? row, ready ? [] : explainValidationErrors(state)) };
}

/**
 * Remove a custom domain (both rows of a root claim): revoke and quarantine
 * first, move the primary back to the platform subdomain if it was one of
 * them, then delete at Cloudflare (DOM-5). A failed delete keeps the
 * Cloudflare id; the platform job retries it.
 */
export async function removeDomain(
  platformDb: D1Database,
  api: CustomHostnameApi,
  tenantId: string,
  rawHost: string,
  now = new Date(),
): Promise<DomainResult<{ removed: string[] }>> {
  const host = normalizeHost(rawHost);
  const row = host ? await ownedRow(platformDb, tenantId, host) : null;
  if (!row || row.kind !== "custom" || !row.domain_group) {
    return { ok: false, status: 404, error: "Domain tidak ditemukan di toko ini." };
  }
  const group = (
    await platformDb
      .prepare(
        `SELECT host, is_primary, cf_custom_hostname_id FROM tenant_hosts
         WHERE tenant_id = ? AND kind = 'custom' AND domain_group = ? AND status != 'revoked'`,
      )
      .bind(tenantId, row.domain_group)
      .all<{ host: string; is_primary: number; cf_custom_hostname_id: string | null }>()
  ).results;
  const quarantine = new Date(now.getTime() + QUARANTINE_MS).toISOString();
  await platformDb.batch([
    ...group.map((member) =>
      platformDb
        .prepare(
          `UPDATE tenant_hosts SET status = 'revoked', is_primary = 0, revoked_at = ?, quarantine_until = ?
           WHERE host = ? AND tenant_id = ?`,
        )
        .bind(now.toISOString(), quarantine, member.host, tenantId),
    ),
    // Decided from the state inside this transaction, not from the read above:
    // a promotion that landed in between still leaves the tenant a primary.
    platformDb
      .prepare(
        `UPDATE tenant_hosts SET is_primary = 1 WHERE tenant_id = ? AND kind = 'subdomain' AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM tenant_hosts WHERE tenant_id = ? AND is_primary = 1)`,
      )
      .bind(tenantId, tenantId),
    await bumpCacheVersion(platformDb, tenantId),
  ]);
  for (const member of group) {
    if (!member.cf_custom_hostname_id) continue;
    try {
      await api.remove(member.cf_custom_hostname_id);
      await platformDb
        .prepare("UPDATE tenant_hosts SET cf_custom_hostname_id = NULL WHERE host = ? AND status = 'revoked'")
        .bind(member.host)
        .run();
    } catch (error) {
      console.error("hostname-delete-failed", { host: member.host, error: String(error) });
    }
  }
  return { ok: true, value: { removed: group.map((member) => member.host) } };
}

export const PROBE_PATH = "/.well-known/adsbook-probe";

/**
 * What a host answers to a probe: HMAC-SHA256 under the tenant's own session
 * key (`install_secrets`), over the host the request reached and a fresh
 * nonce. Only the tenant's own store can compute it, so an unrelated origin
 * cannot replay it, and it is bound to one host and one probe.
 */
export async function probeAnswer(secret: string, host: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`adsbook-probe:${host}:${nonce}`));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const PROBE_NONCE = /^[0-9a-f]{32}$/;

/** §4 "Probe and promote": the host, over HTTPS, answers this tenant's proof for a fresh nonce. */
export async function probeHost(host: string, secret: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (secret.length < 32) return false;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    const response = await fetcher(`https://${host}${PROBE_PATH}?n=${nonce}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return response.status === 200 && (await response.text()).trim() === (await probeAnswer(secret, host, nonce));
  } catch {
    return false;
  }
}

/** Make an active host primary — a custom one only after its probe passes. */
export async function setPrimaryDomain(
  platformDb: D1Database,
  tenantId: string,
  rawHost: string,
  probe: (host: string) => Promise<boolean>,
): Promise<DomainResult<DomainView>> {
  const host = normalizeHost(rawHost);
  const row = host ? await ownedRow(platformDb, tenantId, host) : null;
  if (!row) return { ok: false, status: 404, error: "Domain tidak ditemukan di toko ini." };
  if (row.status !== "active") return { ok: false, status: 409, error: "Domain belum aktif." };
  if (row.kind === "custom" && !(await probe(row.host))) {
    return { ok: false, status: 409, error: `Domain ${row.host} belum menayangkan toko ini lewat HTTPS. Domain utama tidak diubah.` };
  }
  // One transaction, and the old primary is cleared only while the target is
  // still active: a removal racing the probe leaves the old primary in place.
  const eligible = "EXISTS (SELECT 1 FROM tenant_hosts WHERE host = ? AND tenant_id = ? AND status = 'active')";
  const [, promoted] = await platformDb.batch([
    platformDb
      .prepare(`UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = ? AND is_primary = 1 AND host != ? AND ${eligible}`)
      .bind(tenantId, row.host, row.host, tenantId),
    platformDb.prepare("UPDATE tenant_hosts SET is_primary = 1 WHERE host = ? AND tenant_id = ? AND status = 'active'").bind(row.host, tenantId),
    await bumpCacheVersion(platformDb, tenantId),
  ]);
  if (Number(promoted.meta?.changes ?? 0) !== 1) {
    return { ok: false, status: 409, error: "Domain berubah saat diperiksa. Domain utama tidak diubah." };
  }
  const fresh = await ownedRow(platformDb, tenantId, row.host);
  return { ok: true, value: view(fresh ?? row) };
}
