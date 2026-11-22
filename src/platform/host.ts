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

/**
 * The marketing site's public paths on a platform host (T-40, PR-25), each
 * rewritten to its page under `src/pages/platform/`. Only platform hosts read
 * this map: on a seller host `/`, `/harga` or `/faq` stay the seller's own.
 */
export const PLATFORM_SITE_ROUTES: Readonly<Record<string, string>> = {
  "/": "/platform/site",
  "/fitur": "/platform/site/fitur",
  "/cara-kerja": "/platform/site/cara-kerja",
  "/harga": "/platform/site/harga",
  "/faq": "/platform/site/faq",
  "/kontak": "/platform/site/kontak",
  "/daftar": "/platform/signup",
  "/masuk": "/platform/masuk",
  "/lupa-password": "/platform/lupa-password",
  "/syarat": "/platform/syarat",
  "/privasi": "/platform/privasi",
  "/robots.txt": "/platform/site/robots.txt",
  "/sitemap.xml": "/platform/site/sitemap.xml",
  "/llms.txt": "/platform/site/llms.txt",
};

/** The operator console's host (DOM-2): it shares the Worker with the site but is never the site. */
export const PLATFORM_CONSOLE_HOST = "app.adsbook.id";

const withoutTrailingSlash = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname);
const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * PLATFORM-SEO-AND-VISUAL-BANNERS-SPEC §1–2: the retired `/coba` moves for
 * good to the home (301, query kept so an old ad link keeps its UTMs and click
 * ids), and the console host's root opens the console (302). GET/HEAD only.
 */
export function platformRedirect(url: URL, method: string, host: string): { status: 301 | 302; location: string } | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const path = withoutTrailingSlash(url.pathname);
  if (host === PLATFORM_CONSOLE_HOST) {
    if (path === "/") return { status: 302, location: "/platform" };
    // The console host is never the site: a marketing path moves to the site's own host.
    if (consoleHostRefuses(url.pathname)) return platformSitePath(url.pathname) || path === "/coba" ? { status: 301, location: `https://${SITE_HOST}${path === "/coba" ? "/" : url.pathname}${url.search}` } : null;
  }
  if (path === "/coba") return { status: 301, location: `/${url.search}` };
  return null;
}

/** The site's host, where the console host sends a marketing path. */
export const SITE_HOST = "adsbook.id";

/** On the console host only the console, its APIs, its root and its robots.txt answer (PLATFORM-SEO review P2-3). */
export function consoleHostRefuses(pathname: string): boolean {
  const path = withoutTrailingSlash(pathname);
  return !(path === "/" || path === "/robots.txt" || isPlatformRoute(pathname));
}

/**
 * Platform responses that must never be indexed (Paduka, 2026-11-19: "halaman
 * register, login, admin, dan backend operator jangan sampai ke index"):
 * everything on the console host, /daftar, /masuk, /lupa-password, /platform* and /api/*.
 * They stay crawlable (robots.txt never disallows /daftar or /masuk) so the
 * header is read.
 */
export function platformNoindex(host: string, pathname: string): boolean {
  if (host === PLATFORM_CONSOLE_HOST) return true;
  const path = withoutTrailingSlash(pathname);
  return path === "/daftar" || path === "/masuk" || path === "/lupa-password" || isPlatformRoute(pathname) || under(pathname, "/api");
}

/** Tenant paths that must never be indexed: the owner's way in, the admin, APIs and embeds. */
export function tenantNoindex(pathname: string): boolean {
  const path = withoutTrailingSlash(pathname);
  return path === "/hello" || path === "/pemulihan" || under(pathname, "/admin") || under(pathname, "/api") || under(pathname, "/embed");
}

export const NOINDEX_HEADER = "noindex, nofollow";

/** The response with `X-Robots-Tag: noindex, nofollow`, copied first when its headers are immutable. */
export function withNoindex(response: Response): Response {
  try {
    response.headers.set("X-Robots-Tag", NOINDEX_HEADER);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set("X-Robots-Tag", NOINDEX_HEADER);
    return copy;
  }
}

/** The page a public marketing path renders, or null (exact match; one trailing slash allowed). */
export function platformSitePath(pathname: string): string | null {
  const key = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return Object.hasOwn(PLATFORM_SITE_ROUTES, key) ? PLATFORM_SITE_ROUTES[key] : null;
}

/** Internal platform routes: served on platform hosts only, never on a tenant host. */
/** Platform pages (`/platform/…`) and platform APIs (`/api/platform/…`, API-4). */
export function isPlatformRoute(pathname: string): boolean {
  return (
    pathname === "/platform" ||
    pathname.startsWith("/platform/") ||
    pathname === "/api/platform" ||
    pathname.startsWith("/api/platform/")
  );
}

/**
 * Where a request on a non-primary tenant host is sent once a custom domain is
 * the active primary (T-43, Paduka 2026-11-16): `www.<root>` and the store's
 * own `<slug>.adsbook.my.id` answer GET/HEAD with a 301 to the same path and query
 * (click ids and UTMs kept) on the primary. Null when the request stays here.
 *
 * Never moved: `/api/*` (webhooks are bound to the subdomain, SEC-5; the
 * handoff and owner recovery post there, IAM-8/IAM-9), `/pemulihan`, `/hello`
 * and `/admin*` (the owner's way in survives a broken custom DNS, and the
 * `__Host-` session cookie belongs to the host it was set on), and
 * `/.well-known/*` (certificate validation and the HTTPS probe). A primary is
 * custom only after its HTTPS probe; removing or replacing the domain moves
 * the primary back to the subdomain, and the redirect stops with it.
 */
export function primaryHostRedirect(
  url: URL,
  method: string,
  tenant: { hostKind: "subdomain" | "custom"; primaryHost: string | null } | null | undefined,
): string | null {
  if (!tenant?.primaryHost || url.hostname === tenant.primaryHost) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  const path = url.pathname;
  if (path.startsWith("/api/") || path.startsWith("/.well-known/")) return null;
  const onWww = tenant.hostKind === "custom" && url.hostname === `www.${tenant.primaryHost}`;
  const onSubdomain = tenant.hostKind === "subdomain";
  if (!onWww && !onSubdomain) return null;
  if (onSubdomain && (path === "/pemulihan" || path === "/hello" || path === "/admin" || path.startsWith("/admin/"))) return null;
  // Same scheme and port as the request: https in production, the local port in development.
  return `${url.protocol}//${tenant.primaryHost}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
}
