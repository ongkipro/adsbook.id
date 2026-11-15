/**
 * Host handling for the request gate (docs/spec/08-DOMAIN-ROUTING.md §2).
 * Pure functions: no I/O, no environment reads beyond what the caller passes.
 */

/** The platform's own hosts in production (DOM-2, exact match only). */
export const PRODUCTION_PLATFORM_HOSTS: readonly string[] = ["adsbook.id", "app.adsbook.id"];

/**
 * Certificate-validation paths (DOM-1): passed through before any host
 * classification, so a pending custom hostname can complete HTTP DCV.
 * `/.well-known/cf-custom-hostname-challenge/*` is deliberately absent: that
 * pre-validation token is served by the seller's current origin, not by us.
 */
export function isValidationPath(pathname: string): boolean {
  return pathname.startsWith("/.well-known/acme-challenge/") || pathname.startsWith("/.well-known/pki-validation/");
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lowercase, strip the port and one trailing dot; refuse IP literals, control
 * characters, empty labels and anything over 253 characters. Returns null for
 * anything that cannot be a tenant or platform host. `X-Forwarded-Host` is
 * never consulted: the caller passes the request's own Host.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Control characters, whitespace and anything outside printable ASCII.
  if (/[^\x21-\x7e]/.test(raw)) return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) return null; // IPv6 literal
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    if (!/^\d{1,5}$/.test(host.slice(colon + 1))) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253 || IPV4.test(host) || host.includes(":")) return null;
  const labels = host.split(".");
  if (labels.some((label) => !LABEL.test(label))) return null;
  return host;
}

/**
 * The exact platform allowlist. `extra` comes from the platform's own
 * configuration (`PLATFORM_HOSTS`, comma separated) for local development —
 * a platform setting, never a tenant one. Entries are normalised the same way.
 */
export function platformHosts(extra?: string | null): ReadonlySet<string> {
  const hosts = new Set(PRODUCTION_PLATFORM_HOSTS);
  for (const entry of (extra ?? "").split(",")) {
    const host = normalizeHost(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Internal platform routes: served on platform hosts only, never on a tenant host. */
export function isPlatformRoute(pathname: string): boolean {
  return pathname === "/platform" || pathname.startsWith("/platform/");
}
