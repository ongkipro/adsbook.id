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
import { BROWSER_UNSUPPORTED_MESSAGE, canAccessAdminRoute, getDefaultAdminRoute, unsafeRequestVerdict } from './lib/auth';
import { resolveAdminSession } from './lib/admin-session';
import { resolveAuthSecret } from './lib/auth-secret';
import { getRuntimeEnv } from './lib/env';
import { isRegisteredNativeSlug, productPageRedirect } from './lib/native-landing-pages';
import { readStoreIdentity, resolveTenantConfig } from './lib/tenant';
import {
  buildEmbedFrameAncestors,
  resolveEmbedAllowedOrigins,
} from './lib/embed-security';
import { SCHEMA_UPGRADE_ERROR_LABEL } from './lib/schema-version';
import { CMS_VERSION } from './lib/version';
import { resolveHostRedirect } from './lib/host-redirect';
import { gateRequest, type GateEnv } from './platform/gate';
import { bumpTenantCacheVersion, type TenantContext } from './platform/control-plane';
import { isStoreReady, readReadiness, servedBeforeReady } from './platform/readiness.ts';
import { demoRefusal } from './platform/demo.ts';
import { billingState, isLive, subscriptionRefusal } from './platform/billing.ts';
import { notifyOperator, type Notice } from './platform/notify.ts';
import { statePage } from './platform/state-pages';
import { openTenantDb, TenantUnavailableError, type TenantDbEnv } from './platform/tenant-db';
import { buildRequestLog, requestId, routeLabel, writeRequestLog, type HostKind } from './platform/request-log';
import { bumpsStorefrontCache, edgeCacheRequest, readEdgeCache, readUploadCache, uploadCacheRequest, writeEdgeCache, writeUploadCache } from './lib/edge-cache';
import { scopeFromLocals } from './platform/keys.ts';
import { PROBE_NONCE, PROBE_PATH, probeAnswer, tenantHostSuffix } from './platform/hostnames.ts';
import { platformNoindex, platformSitePath, primaryHostRedirect, tenantNoindex, withNoindex } from './platform/host.ts';
import { platformGuard } from './platform/admin/guard.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function applySecurityHeaders(
  response: Response,
  isPrivate: boolean,
  frameAncestors?: string,
) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (frameAncestors) {
    // The embed form: the storefront policy, framed only by its allowed origins.
    response.headers.delete('X-Frame-Options');
    response.headers.set('Content-Security-Policy', `${STOREFRONT_CSP}; ${frameAncestors}`);
  } else {
    response.headers.set('X-Frame-Options', 'DENY');
    // A-214 (T-47): every public storefront response carries the storefront
    // policy; private responses get ADMIN_CSP below.
    if (!isPrivate) response.headers.set('Content-Security-Policy', `${STOREFRONT_CSP}; frame-ancestors 'none'`);
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
  if (isPrivate) {
    // O2O: a seller's own Cloudflare cache rules run first; `private` keeps them off it (T-25).
    response.headers.set('Cache-Control', 'private, no-store');
    // SEC-3: admin pages carry their own policy, never a seller tag host. No
    // script-src yet (Astro's hydration scripts are inline); what it does fix
    // is framing, <base> hijacking, plugins and where a form may post.
    if (!frameAncestors) response.headers.set('Content-Security-Policy', ADMIN_CSP);
  }
  return response;
}

/**
 * The storefront's Content-Security-Policy (A-214, T-47, SEC-3): exactly the
 * hosts the storefront loads — the Meta Pixel, Google Tag Manager and Google
 * Ads/Analytics per Google's tag-platform CSP guide, the GTM noscript frame —
 * and any https image (landing pages take image URLs). Scripts stay
 * 'unsafe-inline': the page bootstraps are inline and anonymous HTML is
 * edge-cached (ADR-029), so a per-response nonce cannot be used. No
 * 'unsafe-eval': GTM Custom JavaScript variables evaluate to undefined, and
 * a seller's GTM that loads another vendor's script is blocked (T-47
 * escalation: a per-tenant allowance would be a new requirement).
 */
/** T-44: per-isolate memory of notices already claimed, so a ready store or a busy checkout costs no write per request. */
const readyNoticed = new Set<string>();
const firstOrderNoticed = new Set<string>();
const FIRST_ORDER_ROUTES = new Set(['/api/submit-order', '/api/submit-middle-order', '/api/v1/checkout']);

/** Fire one operator notice after the response (never awaited by the request). */
function operatorNotice(context: APIContext, notice: Notice) {
  const env = (getRuntimeEnv(context.locals) ?? {}) as Record<string, unknown>;
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  if (!platformDb) return;
  const task = notifyOperator(env, platformDb, notice);
  context.locals.cfContext?.waitUntil(task);
}

export const STOREFRONT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.googleadservices.com https://www.google.com https://connect.facebook.net https://analytics.tiktok.com",
  "connect-src 'self' https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://*.google.com https://www.google.co.id https://*.g.doubleclick.net https://ad.doubleclick.net https://www.googleadservices.com https://pagead2.googlesyndication.com https://www.facebook.com https://connect.facebook.net https://analytics.tiktok.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-src https://www.googletagmanager.com https://td.doubleclick.net https://www.facebook.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const ADMIN_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

/** Platform pages: the admin policy, except a form may also post to a seller subdomain (IAM-8). */
function platformCsp(env: ReturnType<typeof getRuntimeEnv>): string {
  const suffix = tenantHostSuffix((env ?? {}) as Record<string, unknown>);
  const sellers = suffix === 'localhost' ? 'http://*.localhost:*' : `https://*.${suffix}`;
  return `frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${sellers}; object-src 'none'`;
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
        // T-40: a public marketing path renders its page under /platform/
        // in place (no second middleware pass); the guard still runs on that
        // page's path, so a mapped admin path could never skip it.
        const sitePath = platformSitePath(context.url.pathname);
        const guardUrl = sitePath ? new URL(sitePath, context.url) : context.url;
        // T-27: platform admin needs a platform session (IAM-3); signup and sign-in are public.
        const guard = await platformGuard(context.request, guardUrl, (getRuntimeEnv(context.locals) ?? {}) as Record<string, unknown>);
        if (guard.kind === 'deny') {
          response = applySecurityHeaders(guard.response, true);
        } else {
          if (guard.user) context.locals.platformUser = guard.user;
          // Marketing pages are public and identical for every visitor, so
          // they are not marked private the way the admin is.
          // The query string rides along: `/daftar?paket=12m` must reach the page.
          response = applySecurityHeaders(sitePath ? await next(`${sitePath}${context.url.search}`) : await next(), !sitePath);
        }
        // The signup page posts the IAM-8 handoff to the new seller host.
        response.headers.set('Content-Security-Policy', platformCsp(getRuntimeEnv(context.locals)));
        // PLATFORM-SEO-AND-VISUAL-BANNERS-SPEC §2: register, login, console and APIs never reach an index.
        if (platformNoindex(result.host, context.url.pathname)) response = withNoindex(response);
      } else {
        hostKind = 'tenant';
        tenantId = result.tenant.tenantId;
        context.locals.tenantContext = result.tenant;
        response = await handleTenantRequest(context, next);
        // The owner's way in, the admin, APIs and embeds never reach an index.
        if (tenantNoindex(context.url.pathname)) response = withNoindex(response);
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
  // T-25: once a custom primary is active the platform subdomain stays
  // reachable (webhooks, sign-in) but never competes with it in search.
  // ADR-041: a store in Preview Mode or past its grace is not live; nothing of
  // it is indexed, and its buyer-facing pages carry a banner.
  const billing = (() => {
    const tenant = context.locals.tenantContext;
    if (!tenant || tenant.isDemo) return null;
    return billingState(tenant, new Date());
  })();
  const indexedElsewhere = (() => {
    const tenant = context.locals.tenantContext;
    if (billing && !isLive(billing)) return true;
    return Boolean(tenant && tenant.hostKind === 'subdomain' && tenant.primaryHost && tenant.primaryHost !== tenant.host);
  })();

  // Persist ad attribution click ids (Google, Meta, TikTok, UTMs) from landing/embed URL.
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
    // The embed widget carries the host page's `_ttp` the same way as `_fbp`.
    if (clickIds._ttp) {
      response.headers.append(
        'Set-Cookie',
        `_ttp=${encodeURIComponent(clickIds._ttp)}; Path=/; Max-Age=${365 * 24 * 60 * 60};${sameSiteAttr}`,
      );
    }
  };
  // An uploaded image another visitor fetched is answered before the schema
  // check, the store lookup and the R2 read: it is the same bytes for everyone.
  const uploadKey = uploadCacheRequest(context.request, url, scopeFromLocals(context.locals));
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

  // T-43 (PR-28) and Paduka 2026-11-16: once a custom domain is the active
  // primary, `www.<root>` and the store's own `<slug>.adsbook.my.id` answer
  // GET/HEAD with a 301 to the same path and query on the primary. APIs,
  // webhooks, the owner's sign-in and recovery, admin and `.well-known` stay
  // (`primaryHostRedirect`, src/platform/host.ts). A primary is custom only
  // after its HTTPS probe; removing the domain moves it back to the subdomain.
  const toPrimary = primaryHostRedirect(url, context.request.method, context.locals.tenantContext);
  if (toPrimary) {
    return applySecurityHeaders(context.redirect(toPrimary, 301), false);
  }

  // The edge cache (ADR-029): an anonymous page another visitor rendered in
  // the last two minutes skips the schema check, the store lookup, the page's
  // D1 reads and the render. It sits after the gate, so no cache is read for a
  // host that has not resolved to an active tenant.
  const edgeKey = edgeCacheRequest(context.request, url, scopeFromLocals(context.locals));
  if (edgeKey) {
    const hit = await readEdgeCache(edgeKey);
    if (hit) {
      const cached = applySecurityHeaders(hit, false);
      if (url.hostname.endsWith('.workers.dev') || indexedElsewhere) cached.headers.set('X-Robots-Tag', 'noindex, nofollow');
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
    tenantContext.primaryHost ?? tenantContext.host,
  );

  // Provisioning writes the one `stores` row before a tenant becomes active
  // (MULTI-TENANT-DESIGN.md §3.1), so an active tenant without it is a broken
  // store: a neutral 503 for that tenant, never an installer (`/install` and
  // INSTALL_TOKEN are gone, T-21). `unknown` is a failed read, and the page
  // still renders from the product defaults rather than failing the store.
  if (identity.state === 'uninstalled' || identity.state === 'unmigrated') {
    console.error('tenant-store-row-missing', { tenant_id: tenantContext.tenantId, state: identity.state });
    return statePage('unavailable', url.pathname);
  }

  // §4 "Probe and promote" (T-25): before a custom host may become primary,
  // the platform asks it, over HTTPS, for a proof only this tenant's store can
  // compute, bound to the host reached and the caller's nonce.
  if (url.pathname === PROBE_PATH) {
    const nonce = url.searchParams.get('n') ?? '';
    const secret = await resolveAuthSecret(identityDb, tenantContext.tenantId);
    if (!PROBE_NONCE.test(nonce) || secret.length < 32) {
      return applySecurityHeaders(new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } }), false);
    }
    return applySecurityHeaders(new Response(await probeAnswer(secret, url.hostname, nonce), {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    }), false);
  }

  // PR-23 (T-38): until the store meets the ready predicate, buyers get the
  // neutral "toko belum siap" page and no checkout; the owner's admin, sign-in,
  // recovery and provider callbacks still answer. Computed from data on every
  // request, so the store opens the moment the last step is saved. A failed
  // read fails closed. The page is no-store, so nothing unready is edge-cached.
  // PR-26 (T-41): the demo store skips readiness for browsing only; instead,
  // every provider entry point and every write is refused before any route runs.
  if (billing) context.locals.billing = { state: billing, adSignalsPaused: !isLive(billing) };
  if (tenantContext.isDemo) {
    const refusal = demoRefusal(url.pathname, context.request.method);
    if (refusal) return applySecurityHeaders(refusal, false);
  } else if (!servedBeforeReady(url.pathname, context.request.method)) {
    const ready = await readReadiness(identityDb).then(isStoreReady, (error) => {
      console.error('store-readiness-unreadable', { tenant_id: tenantContext.tenantId, error: String(error) });
      return null;
    });
    if (ready !== true) {
      // Owner preview: the signed-in seller sees the real storefront before it
      // opens, buyers keep the neutral page. Pages only (GET/HEAD, never /api:
      // checkout stays closed), and never cached — a request with the session
      // cookie never has an edge-cache key, and the answer is marked no-store.
      const ownerPreview =
        ready === false &&
        (context.request.method === 'GET' || context.request.method === 'HEAD') &&
        !(url.pathname === '/api' || url.pathname.startsWith('/api/')) &&
        Boolean(await resolveAdminSession(identityDb, context.request, await resolveAuthSecret(identityDb, tenantContext.tenantId)));
      if (!ownerPreview) return statePage(ready === false ? 'not-ready' : 'unavailable', url.pathname);
      context.locals.ownerPreview = true;
    }
    // T-44: the operator hears once that this store is ready (claimed in
    // PLATFORM_DB; this isolate stops asking after the first time). Only a
    // visit that passed the ready check counts: an owner previewing an unready
    // store reaches here too, and must neither send nor claim the notice.
    if (ready === true && !readyNoticed.has(tenantContext.tenantId)) {
      readyNoticed.add(tenantContext.tenantId);
      operatorNotice(context, { tenantId: tenantContext.tenantId, slug: tenantContext.slug, kind: 'ready', storeName: context.locals.tenant?.name });
    }
  }

  // ADR-041 (BILL-5), after readiness so an unready store still says so: buyer
  // orders, anonymous quotes and custom-domain claims need a live subscription;
  // sign-in, admin and /admin/billing never do.
  if (billing) {
    const refusal = subscriptionRefusal(url.pathname, context.request.method, billing);
    if (refusal) return applySecurityHeaders(refusal, false);
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
          '',
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

  // IAM-5 strict CSRF: a sibling seller host is same-site, so the only safe
  // unsafe request is one whose Origin is this origin and whose browser says
  // `Sec-Fetch-Site: same-origin`.
  if (isPrivate && UNSAFE_METHODS.has(context.request.method)) {
    const verdict = unsafeRequestVerdict(context.request, url);
    if (verdict !== 'allowed') {
      const body = verdict === 'browser_unsupported'
        ? { success: false, error: BROWSER_UNSUPPORTED_MESSAGE, code: 'browser_unsupported' }
        : { success: false, error: 'Forbidden request origin', code: 'forbidden_origin' };
      return applySecurityHeaders(new Response(JSON.stringify(body), {
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
      await resolveAuthSecret(identityDb, tenantContext.tenantId),
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
  // Paket 1: an admin write buyers see reaches them on the next request, not in two minutes.
  if (isAdminApi && bumpsStorefrontCache(url.pathname, context.request.method, rendered.status)) {
    await bumpTenantCacheVersion(getRuntimeEnv(context.locals), tenantContext.tenantId);
  }
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

  // A *.workers.dev address, or the platform subdomain once a custom primary
  // is active, must never compete with the store's domain in search.
  if (url.hostname.endsWith('.workers.dev') || indexedElsewhere || context.locals.ownerPreview) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  // The owner's preview of an unready store is for them alone.
  if (context.locals.ownerPreview) response.headers.set('Cache-Control', 'private, no-store');

  if (!isPrivate) persistClickIds(response);

  // T-44: a store's first order (any checkout route that answered success).
  if (
    context.request.method === 'POST' &&
    response.status >= 200 && response.status < 300 &&
    FIRST_ORDER_ROUTES.has(url.pathname) &&
    !firstOrderNoticed.has(tenantContext.tenantId)
  ) {
    firstOrderNoticed.add(tenantContext.tenantId);
    operatorNotice(context, { tenantId: tenantContext.tenantId, slug: tenantContext.slug, kind: 'first_order', storeName: context.locals.tenant?.name });
  }

  return response;
  }
}

export const onRequest = createMiddleware();
