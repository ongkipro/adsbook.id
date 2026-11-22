/**
 * The request gate (TD-1): the first thing every request meets. In order —
 * certificate-validation paths pass through (DOM-1); the Host is normalised
 * and either matches the platform allowlist exactly or is resolved against
 * `PLATFORM_DB` (TEN-1, DOM-2); anything else is refused before any cache read
 * or tenant query. Nothing here reads or writes KV. A plain-HTTP GET or HEAD
 * on a production platform host is sent to HTTPS first (`platformHttpsRedirect`).
 */
import { ensureControlPlane, resolveTenantHost, type HostCache, type TenantContext } from "./control-plane.ts";
import { consoleHostRefuses, isPlatformRoute, isValidationPath, NOINDEX_HEADER, PLATFORM_CONSOLE_HOST, PRODUCTION_PLATFORM_HOSTS, normalizeHost, platformHosts, platformNoindex, platformRedirect, platformSitePath } from "./host.ts";
import { PLATFORM_DOMAIN, SELLER_ZONE } from "./hostnames.ts";
import { statePage } from "./state-pages.ts";

export type GateResult =
  | { kind: "validation"; response: Response }
  | { kind: "platform"; host: string }
  | { kind: "tenant"; tenant: TenantContext }
  | {
      kind: "refused";
      hostKind: "tenant" | "platform" | "unknown";
      response: Response;
      /** Why, for the request log line (OBS-1): never a host, path or secret. */
      reason?: string;
    };

export type GateEnv = {
  PLATFORM_DB?: unknown;
  /** Extra platform hosts for local development (comma separated). */
  PLATFORM_HOSTS?: unknown;
};

export type GateDeps = {
  now?: Date;
  cache?: HostCache;
  /** Forwards a certificate-validation request untouched. */
  passThrough?: (request: Request) => Promise<Response>;
  ensureSchema?: (db: D1Database) => Promise<void>;
};

const LOCAL_HOST = /(^|\.)localhost$/;

/**
 * DOM-1. In production the Worker hands the request on (`fetch(request)` to the
 * originless fallback; T-25 proves it with a live issuance). On a local host
 * there is no CA and a fetch would loop back into this Worker, so it answers 404.
 */
async function defaultPassThrough(request: Request): Promise<Response> {
  // An IP literal or an unparseable Host is not a hostname a CA validates, and
  // on a local listener a fetch would come straight back here (T-17 review).
  const host = normalizeHost(new URL(request.url).host);
  if (!host || LOCAL_HOST.test(host)) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return fetch(request);
}

/** The fixed reason code the request log line carries when the fallback below answered. */
const HTTPS_FALLBACK_REASON = "http_to_https";

/** Paths the fallback never answers: certificate and hostname validation, Cloudflare's own paths, provider callbacks. */
const HTTPS_FALLBACK_SKIP = ["/.well-known/", "/cdn-cgi/", "/api/platform/webhooks/"];

/**
 * Defensive fallback for the platform hosts: plain HTTP is not served. It is
 * not the primary control (a zone redirect rule is) and is not known to be
 * active in production until a plain-HTTP request has been seen to reach it.
 *
 * Narrow on purpose. GET and HEAD only: a redirect can turn a POST into a GET,
 * the body has already crossed in the clear, and most callback senders never
 * follow one. The two production platform hosts only: never a `PLATFORM_HOSTS`
 * development host, never a tenant or custom host (the middleware has its own
 * http to https step for those). Never certificate validation, `/cdn-cgi/` or a
 * provider callback, checked on the raw path and on Astro's normalised one.
 *
 * The scheme is the one the runtime put in the request's own URL. Nothing
 * here reads a header, so a client cannot pick the scheme or the target host:
 * the target is always `https://` plus an allowlisted host. Temporary (302,
 * no-store): if a runtime ever reported the wrong scheme for a host, a
 * permanent redirect would stay cached in browsers.
 */
function platformHttpsRedirect(request: Request, url: URL, host: string): Response | null {
  const own = new URL(request.url);
  if (own.protocol !== "http:") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!PRODUCTION_PLATFORM_HOSTS.includes(host)) return null;
  if (HTTPS_FALLBACK_SKIP.some((prefix) => own.pathname.startsWith(prefix) || url.pathname.startsWith(prefix))) return null;
  return new Response(null, {
    status: 302,
    headers: { Location: `https://${host}${own.pathname}${own.search}`, "Cache-Control": "no-store" },
  });
}

export async function gateRequest(
  request: Request,
  url: URL,
  env: GateEnv | null | undefined,
  deps: GateDeps = {},
): Promise<GateResult> {
  if (isValidationPath(url.pathname)) {
    return { kind: "validation", response: await (deps.passThrough ?? defaultPassThrough)(request) };
  }

  // The Host of the request itself; forwarded-host headers are never read.
  const host = normalizeHost(new URL(request.url).host);
  if (!host) return { kind: "refused", hostKind: "unknown", response: statePage("not-found", url.pathname) };

  const extra = typeof env?.PLATFORM_HOSTS === "string" ? env.PLATFORM_HOSTS : null;
  if (platformHosts(extra).has(host)) {
    const secure = platformHttpsRedirect(request, url, host);
    if (secure) return { kind: "refused", hostKind: "platform", response: secure, reason: HTTPS_FALLBACK_REASON };
    const moved = platformRedirect(url, request.method, host);
    if (moved) {
      const headers: Record<string, string> = { Location: moved.location, "Cache-Control": moved.status === 301 ? "public, max-age=3600" : "no-store" };
      if (platformNoindex(host, url.pathname)) headers["X-Robots-Tag"] = NOINDEX_HEADER;
      return { kind: "refused", hostKind: "platform", response: new Response(null, { status: moved.status, headers }) };
    }
    // Platform host: only platform routes and the marketing site's public paths
    // (T-40) exist here; every tenant route is a 404. The console host serves
    // no marketing path at all (a GET/HEAD one moved to the site above).
    if ((!isPlatformRoute(url.pathname) && !platformSitePath(url.pathname)) || (host === PLATFORM_CONSOLE_HOST && consoleHostRefuses(url.pathname))) {
      return { kind: "refused", hostKind: "platform", response: statePage("not-found", url.pathname) };
    }
    return { kind: "platform", host };
  }
  // The seller zone's own apex and www are no store (slug `www` is reserved):
  // they go to the platform's main domain (Paduka, 2026-11-16).
  if (host === SELLER_ZONE || host === `www.${SELLER_ZONE}`) {
    return {
      kind: "refused",
      hostKind: "platform",
      response: new Response(null, { status: 301, headers: { Location: `https://${PLATFORM_DOMAIN}${url.pathname}${url.search}`, "Cache-Control": "public, max-age=3600" } }),
    };
  }
  // Tenant host: platform routes do not exist here.
  if (isPlatformRoute(url.pathname)) {
    return { kind: "refused", hostKind: "tenant", response: statePage("not-found", url.pathname) };
  }

  const db = env?.PLATFORM_DB as D1Database | undefined;
  if (!db || typeof db.prepare !== "function") {
    return { kind: "refused", hostKind: "tenant", response: statePage("unavailable", url.pathname), reason: "platform_db_unbound" };
  }
  try {
    await (deps.ensureSchema ?? ensureControlPlane)(db);
    const resolution = await resolveTenantHost(db, host, deps.now, deps.cache);
    switch (resolution.kind) {
      case "tenant":
        return { kind: "tenant", tenant: resolution.tenant };
      case "suspended":
        return { kind: "refused", hostKind: "tenant", response: statePage("suspended", url.pathname) };
      case "recovery":
        return { kind: "refused", hostKind: "tenant", response: statePage("recovery", url.pathname) };
      default:
        return { kind: "refused", hostKind: "unknown", response: statePage("not-found", url.pathname) };
    }
  } catch {
    // A control-plane read failure is a 503 for this tenant host (TD-2), never
    // a default tenant. The reason goes on the request's one log line.
    return { kind: "refused", hostKind: "tenant", response: statePage("unavailable", url.pathname), reason: "platform_db_failed" };
  }
}
