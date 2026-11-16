/**
 * The one host-level redirect left once hosts belong to tenants (PR-9):
 * `http:` goes to `https:` on the same host, keeping the path and query (UTM,
 * fbclid). The SaaS zone's "Always Use HTTPS" is a zone setting a custom
 * hostname may not inherit, so the Worker does not depend on it.
 *
 * Alias domains (`PUBLIC_ALIAS_HOSTS` → `PUBLIC_SITE_URL`) were one store per
 * Worker; a tenant's hosts and its primary now live in `tenant_hosts` (T-25).
 *
 * `/api/` is never moved: a webhook or payment callback must still land, most
 * senders do not follow a redirect, and a 301 turns a POST into a GET. Local
 * hosts and bare IP addresses (a LAN or Tailscale preview) are never moved.
 */
export function resolveHostRedirect(url: URL): string | null {
  if (url.pathname.startsWith('/api/')) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^(\d+\.){3}\d+$/.test(host) || host.startsWith('[')) return null;
  if (url.protocol === 'http:') {
    return `https://${url.host}${url.pathname}${url.search}`;
  }
  return null;
}
