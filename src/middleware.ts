import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import {
  CLICK_ID_COOKIE,
  hasClickId,
  mergeClickIds,
  parseClickIdsFromUrl,
  readClickIdCookie,
  serializeClickIds,
} from './lib/click-ids';
import { canAccessAdminRoute, getDefaultAdminRoute } from './lib/auth';
import { resolveAdminSession } from './lib/admin-session';
import { resolveAuthSecret } from './lib/auth-secret';
import { getEnvValue, getRuntimeEnv } from './lib/env';
import { isRegisteredNativeSlug, productPageRedirect } from './lib/native-landing-pages';
import { readStoreIdentity, resolveTenantConfig, siteNoindex } from './lib/tenant';
import {
  buildEmbedFrameAncestors,
  resolveEmbedAllowedOrigins,
} from './lib/embed-security';
import { SCHEMA_UPGRADE_ERROR_LABEL } from './lib/schema-version';
import { CMS_VERSION } from './lib/version';
import { resolveHostRedirect } from './lib/host-redirect';
import { gateRequest, type GateEnv } from './platform/gate';
import type { TenantContext } from './platform/control-plane';
import { statePage } from './platform/state-pages';
import { openTenantDb, TenantUnavailableError, type TenantDbEnv } from './platform/tenant-db';
import { buildRequestLog, requestId, routeLabel, writeRequestLog, type HostKind } from './platform/request-log';
import { edgeCacheRequest, readEdgeCache, readUploadCache, uploadCacheRequest, writeEdgeCache, writeUploadCache } from './lib/edge-cache';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function applySecurityHeaders(
  response: Response,
  isPrivate: boolean,
  frameAncestors?: string,
) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (frameAncestors) {
    response.headers.delete('X-Frame-Options');
    response.headers.set('Content-Security-Policy', frameAncestors);
  } else {
    response.headers.set('X-Frame-Options', 'DENY');
  }
  // Sent unconditionally on purpose. RFC 6797 section 8.1 requires a user agent
  // to ignore an STS header received over insecure transport, so this is inert
  // on http and on local dev, and there is no protocol to branch on here.
  //
  // No includeSubDomains: this ships to every install, and committing every
  // future subdomain of every store to HTTPS is not a promise this file can
  // keep. No preload either - that one is close to irreversible. A store that
  // wants both can turn on zone-level HSTS in Cloudflare.
  response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isPrivate) response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function loadStoredEmbedAllowedOrigins(
  database: D1Database | undefined,
) {
  if (!database) return null;
  try {
    const row = await database
      .prepare(
        'SELECT embed_allowed_origins FROM stores ORDER BY id LIMIT 1',
      )
      .first<{ embed_allowed_origins: string | null }>();
    return row?.embed_allowed_origins ?? null;
  } catch {
    // A database failure must not silently restore a stale, broader allowlist.
    return "";
  }
}



/**
 * Paths the installer needs before a store exists. Everything else is
 * unreachable until the wizard has run, because everything else assumes a store
 * row that is not there yet.
 */
/**
 * The product slug a native landing page has taken over, or null.
 *
 * Reads only when the caller has already established the path is a registered
 * native slug, so this is not a per-request database hit.
 */
async function readNativeProductPageSlug(
  database: D1Database | undefined,
  slug: string,
): Promise<string | null> {
  if (!database?.prepare || !slug) return null;
  try {
    const row = await database
      .prepare(
        `SELECT p.slug AS product_slug
           FROM landing_pages lp
           INNER JOIN products p ON CAST(p.id AS TEXT) = lp.product_id
          WHERE lp.slug = ?
            AND lp.source = 'native'
            AND lp.is_product_page = 1
            AND lp.is_active = 1
          LIMIT 1`,
      )
      .bind(slug)
      .first<{ product_slug: string }>();
    return row?.product_slug || null;
  } catch (error) {
    // Never take a live landing page down because the claim could not be read.
    console.error('native-landing-claim-read-failed', error);
    return null;
  }
}

function isInstallerRoute(pathname: string): boolean {
  return (
    pathname === '/install' ||
    pathname === '/install/' ||
    pathname === '/api/install'
  );
}

/**
 * The installer's own routes plus the assets its page needs to render. Used
 * only while the store is *not* installed, to let the wizard through.
 *
 * Deliberately not reused for the installed case: an installed store that
 * redirected `/images/…` would answer a missing image with a 302 to the login
 * screen instead of a 404 — which is what it did.
 */
function isInstallerPath(pathname: string): boolean {
  return (
    isInstallerRoute(pathname) ||
    pathname.startsWith('/_astro/') ||
    pathname.startsWith('/images/') ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon.png'
  );
}

/** Opens the request's tenant store; the default is the platform capability. */
export type OpenTenantData = (
  env: ReturnType<typeof getRuntimeEnv>,
  tenant: TenantContext,
) => Promise<D1Database>;

const openTenantStore: OpenTenantData = (env, tenant) =>
  openTenantDb(env as TenantDbEnv, tenant, CMS_VERSION.schemaVersion);

export function createMiddleware(
  openTenantData: OpenTenantData = openTenantStore,
  gate: typeof gateRequest = gateRequest,
) {
  /**
   * The request gate runs first (TD-1): certificate-validation paths, host
   * classification and the authoritative tenant read happen before any cache,
   * schema check or store lookup. One structured log line per request (OBS-1).
   */
  return defineMiddleware(async (context, next) => {
    const started = Date.now();
    let status = 500;
    let hostKind: HostKind = 'unknown';
    let tenantId: string | null = null;
    let reason: string | undefined;
    try {
      const result = await gate(context.request, context.url, getRuntimeEnv(context.locals) as GateEnv);
      let response: Response;
      if (result.kind === 'validation') {
        hostKind = 'validation';
        response = result.response;
      } else if (result.kind === 'refused') {
        hostKind = result.hostKind;
        reason = result.reason;
        response = result.response;
      } else if (result.kind === 'platform') {
        hostKind = 'platform';
        context.locals.platform = { host: result.host };
        response = applySecurityHeaders(await next(), true);
      } else {
        hostKind = 'tenant';
        tenantId = result.tenant.tenantId;
        context.locals.tenantContext = result.tenant;
        response = await handleTenantRequest(context, next);
      }
      status = response.status;
      return response;
    } catch (error) {
      reason = 'unhandled_exception';
      throw error;
    } finally {
      // Exactly one line per request, on every path (OBS-1).
      writeRequestLog(buildRequestLog({
        tenant_id: tenantId,
        host_kind: hostKind,
        route: routeLabel(context.routePattern, hostKind === 'tenant' || hostKind === 'platform' ? 'unmatched' : 'gate'),
        method: context.request.method,
        status,
        duration_ms: Date.now() - started,
        request_id: requestId(context.request),
        ...(reason ? { reason } : {}),
      }));
    }
  });

  async function handleTenantRequest(context: APIContext, next: MiddlewareNext): Promise<Response> {
  // `context.url`, never a URL built from the raw request. Astro routes on a
  // normalized pathname — it decodes percent-escapes in a loop and collapses
  // duplicate slashes — and exposes the result here, while leaving
  // `context.request` at the raw bytes the client sent. Reading the raw URL
  // meant this middleware classified one path while Astro served another:
  // `//api/admin/settings` and `/%61pi/admin/settings` were not "private", so
  // the session check, the role check, the CSRF origin check and the rotation
  // gate were all skipped and the handler ran anyway. Every admin surface was
  // readable, and writable cross-site, with no session at all.
  const url = context.url;
  const runtime = getRuntimeEnv(context.locals);

  // Persist ad attribution click ids (Google, Meta, UTMs) from landing/embed URL.
  // A function, because a page served from the edge cache needs it too: the
  // cookie is written from the request's URL, never from the cached HTML.
  const persistClickIds = (response: Response) => {
    const incoming = parseClickIdsFromUrl(url);
    if (!hasClickId(incoming)) return;
    // Merged, not overwritten. A bare `utm_source` is enough to reach this
    // branch, so writing the parsed URL straight over the cookie let an
    // ordinary WhatsApp or email link erase a `gclid` the merchant had paid
    // for — days before the COD sale that needed it was confirmed.
    const clickIds = mergeClickIds(readClickIdCookie(context.request), incoming);
    const sameSiteAttr = url.protocol === 'https:' ? ' SameSite=None; Secure;' : ' SameSite=Lax;';
    response.headers.append(
      'Set-Cookie',
      `${CLICK_ID_COOKIE}=${encodeURIComponent(serializeClickIds(clickIds))};` +
        ` Path=/; Max-Age=${90 * 24 * 60 * 60};${sameSiteAttr}`,
    );
    if (clickIds._fbp) {
      response.headers.append(
        'Set-Cookie',
        `_fbp=${encodeURIComponent(clickIds._fbp)}; Path=/; Max-Age=${90 * 24 * 60 * 60};${sameSiteAttr}`,
      );
    }
    if (clickIds._fbc) {
      response.headers.append(
        'Set-Cookie',
        `_fbc=${encodeURIComponent(clickIds._fbc)}; Path=/; Max-Age=${90 * 24 * 60 * 60};${sameSiteAttr}`,
      );
    }
  };
  // An uploaded image another visitor fetched is answered before the schema
  // check, the store lookup and the R2 read: it is the same bytes for everyone.
  const uploadKey = uploadCacheRequest(context.request, url);
  if (uploadKey) {
    const hit = await readUploadCache(uploadKey);
    if (hit) return applySecurityHeaders(hit, false);
  }

  // http → https on the same host. Alias-domain redirects (`PUBLIC_ALIAS_HOSTS`
  // → `PUBLIC_SITE_URL`) were one store per Worker; a host is now a row of
  // `tenant_hosts` (PR-9), and the primary host belongs to the tenant (T-25).
  const hostRedirect = resolveHostRedirect(url);
  if (hostRedirect) {
    return applySecurityHeaders(context.redirect(hostRedirect, 301), false);
  }

  // The edge cache (ADR-029): an anonymous page another visitor rendered in
  // the last two minutes skips the schema check, the store lookup, the page's
  // D1 reads and the render. It sits after the gate, so no cache is read for a
  // host that has not resolved to an active tenant.
  const edgeKey = edgeCacheRequest(context.request, url);
  if (edgeKey) {
    const hit = await readEdgeCache(edgeKey);
    if (hit) {
      const cached = applySecurityHeaders(hit, false);
      if (url.hostname.endsWith('.workers.dev') || siteNoindex(runtime)) cached.headers.set('X-Robots-Tag', 'noindex, nofollow');
      persistClickIds(cached);
      return cached;
    }
  }

  // The tenant's own store (TEN-2), opened from the gate's tenant id with its
  // schema brought to this release (MIG-1). A tenant that cannot be served
  // right now is a 503 for that tenant alone (MULTI-TENANT-DESIGN.md §4.5).
  const tenantContext = context.locals.tenantContext;
  let identityDb: D1Database;
  try {
    if (!tenantContext) throw new TenantUnavailableError('protocol', 'no tenant context');
    identityDb = await openTenantData(runtime, tenantContext);
  } catch (error) {
    const reason = error instanceof TenantUnavailableError ? error.reason : 'open_failed';
    console.error(SCHEMA_UPGRADE_ERROR_LABEL, { tenant_id: tenantContext?.tenantId ?? null, reason });
    return statePage(reason === 'recovery' || reason === 'migration' ? 'recovery' : 'unavailable', url.pathname);
  }
  context.locals.tenantDb = identityDb;
  // lazy: pages and APIs that still read `runtimeEnv.OMS_DB` see this tenant's
  // store, never the shared binding, until T-35/T-36/T-46 move them to
  // `tenantDatabase(locals)`; T-46 removes this line with the binding.
  context.locals.runtimeEnv = { ...(runtime ?? {}), OMS_DB: identityDb };

  // Store identity is resolved once per request and handed to every consumer
  // through locals. Doing it here rather than per page keeps consumers
  // synchronous — 125 call sites cannot each be an opportunity to forget an
  // await for a value that cannot change mid-request. ADR-003.
  const identity =
    identityDb && typeof identityDb === 'object'
      ? await readStoreIdentity(identityDb)
      : ({ state: 'unknown' } as const);
  context.locals.tenant = resolveTenantConfig(
    identity.state === 'installed' ? identity.row : null,
  );

  // A migrated database with no store row has never been set up: no migration
  // inserts one. Send the operator to the wizard rather than to twenty call
  // sites that each silently read null. Only `uninstalled` redirects —
  // `unknown` means the query failed, and a transient database fault must never
  // route a live store to its own installer.
  if (
    (identity.state === 'uninstalled' || identity.state === 'unmigrated') &&
    !isInstallerPath(url.pathname)
  ) {
    return applySecurityHeaders(context.redirect('/install'), true);
  }
  // Once installed the wizard is gone for good; it is unauthenticated, so it
  // must not linger as a re-runnable surface.
  if (identity.state === 'installed' && isInstallerRoute(url.pathname)) {
    return applySecurityHeaders(context.redirect('/hello'), true);
  }

  // A native landing page that has taken over a product page must answer on
  // the product URL only. Its route is a real file, so it never reaches the
  // `[slug].astro` catch-all that redirects CMS pages — this is the only place
  // that sees it.
  //
  // Ordered to stay cheap: the register is compiled in, so a path that is not
  // a registered native slug is ruled out in memory and never touches D1. The
  // header check comes first because `/produk/<slug>` rewrites here, and
  // redirecting a rewrite would put the two routes in the loop A21 already
  // paid for once.
  if (
    identity.state === 'installed' &&
    !context.request.headers.get('x-adsbook-product-page') &&
    isRegisteredNativeSlug(url.pathname.replace(/^\/|\/$/g, ''))
  ) {
    const claimedProductSlug = await readNativeProductPageSlug(
      identityDb,
      url.pathname.replace(/^\/|\/$/g, ''),
    );
    if (claimedProductSlug) {
      return applySecurityHeaders(
        // Keep the query string: ads land here with fbclid/gclid and UTM tags.
        productPageRedirect(`/produk/${claimedProductSlug}${url.search}`),
        false,
      );
    }
  }
  const isEmbedForm =
    url.pathname === '/embed/form' || url.pathname === '/embed/form/';
  const embedFrameAncestors = isEmbedForm
    ? buildEmbedFrameAncestors(
        resolveEmbedAllowedOrigins(
          await loadStoredEmbedAllowedOrigins(identityDb),
          getEnvValue('PUBLIC_EMBED_ALLOWED_ORIGINS', runtime),
        ).origins,
      )
    : undefined;
  const isLoginPage = url.pathname === '/hello';
  // Not `startsWith('/admin')`: that also claims `/admin-sale` and
  // `/administrasi`, so a landing page whose slug merely begins with those
  // letters would send every customer to the login screen.
  const isAdminPage =
    url.pathname === '/admin' || url.pathname.startsWith('/admin/');
  const isAdminApi =
    url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/');
  const isPrivate = isAdminPage || isAdminApi;

  if (isAdminApi && UNSAFE_METHODS.has(context.request.method)) {
    const origin = context.request.headers.get('origin');
    const fetchSite = context.request.headers.get('sec-fetch-site');
    if ((origin && origin !== url.origin) || fetchSite === 'cross-site') {
      return applySecurityHeaders(new Response(JSON.stringify({ success: false, error: 'Forbidden request origin' }), {
        status: 403,
        headers: JSON_HEADERS,
      }), true);
    }
  }

  if (isPrivate) {
    // One D1 round trip: the session row joined to its credential (ADR-021).
    const session = await resolveAdminSession(
      identityDb,
      context.request,
      await resolveAuthSecret(runtime, identityDb, tenantContext.tenantId),
    );
    if (!session) {
      if (isAdminApi) {
        return applySecurityHeaders(new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
          status: 401,
          headers: JSON_HEADERS,
        }), true);
      }
      return applySecurityHeaders(context.redirect('/hello'), true);
    }
    const { mustChangePassword } = session;
    context.locals.admin = {
      username: session.username,
      role: session.role,
      mustChangePassword,
    };
    if (!canAccessAdminRoute(session.role, url.pathname)) {
      if (isAdminApi) {
        return applySecurityHeaders(
          new Response(
            JSON.stringify({
              success: false,
              error: "Permission denied.",
              code: "PERMISSION_DENIED",
            }),
            { status: 403, headers: JSON_HEADERS },
          ),
          true,
        );
      }
      return applySecurityHeaders(
        context.redirect(getDefaultAdminRoute(session.role)),
        true,
      );
    }
    if (url.pathname === "/admin") {
      return applySecurityHeaders(
        context.redirect(getDefaultAdminRoute(session.role)),
        true,
      );
    }
    if (mustChangePassword) {
      const mayChangePassword = url.pathname === '/admin/profile'
        || url.pathname === '/api/admin/profile'
        || url.pathname === '/api/admin/logout';
      if (!mayChangePassword) {
        if (isAdminApi) {
          return applySecurityHeaders(new Response(JSON.stringify({
            success: false,
            error: 'Ganti password default sebelum melanjutkan.',
            code: 'PASSWORD_CHANGE_REQUIRED',
          }), { status: 403, headers: JSON_HEADERS }), true);
        }
        return applySecurityHeaders(context.redirect('/admin/profile'), true);
      }
    }
  }

  const rendered = await next();
  // Stored before cookies and security headers are added: the copy carries
  // none of them, and a visitor's own cookies are never part of a shared page.
  if (edgeKey) {
    writeEdgeCache(edgeKey, rendered, context.locals);
    rendered.headers.set('X-Edge-Cache', 'MISS');
  }
  if (uploadKey) {
    writeUploadCache(uploadKey, rendered, context.locals);
    rendered.headers.set('X-Edge-Cache', 'MISS');
  }
  const response = applySecurityHeaders(
    rendered,
    isPrivate || isLoginPage || isEmbedForm,
    embedFrameAncestors,
  );

  // The Worker's own *.workers.dev address stays on so a one-click install has
  // somewhere to open /install (ADR-026). It must never compete with the
  // store's domain in search, whatever site_url says. PUBLIC_SITE_NOINDEX does
  // the same for a whole store, and as a header it also covers the pages that
  // render outside BaseLayout.
  if (url.hostname.endsWith('.workers.dev') || siteNoindex(runtime)) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (!isPrivate) persistClickIds(response);

  return response;
  }
}

export const onRequest = createMiddleware();
