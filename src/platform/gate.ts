/**
 * The request gate (TD-1): the first thing every request meets. In order —
 * certificate-validation paths pass through (DOM-1); the Host is normalised
 * and either matches the platform allowlist exactly or is resolved against
 * `PLATFORM_DB` (TEN-1, DOM-2); anything else is refused before any cache read
 * or tenant query. Nothing here reads or writes KV.
 */
import { ensureControlPlane, resolveTenantHost, type HostCache, type TenantContext } from "./control-plane.ts";
import { isPlatformRoute, isValidationPath, normalizeHost, platformHosts } from "./host.ts";
import { statePage } from "./state-pages.ts";

export type GateResult =
  | { kind: "validation"; response: Response }
  | { kind: "platform"; host: string }
  | { kind: "tenant"; tenant: TenantContext }
  | { kind: "refused"; hostKind: "tenant" | "platform" | "unknown"; response: Response };

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
  log?: (label: string, detail: Record<string, unknown>) => void;
};

const LOCAL_HOST = /(^|\.)localhost$/;

/**
 * DOM-1. In production the Worker hands the request on (`fetch(request)` to the
 * originless fallback; T-25 proves it with a live issuance). On a local host
 * there is no CA and a fetch would loop back into this Worker, so it answers 404.
 */
async function defaultPassThrough(request: Request): Promise<Response> {
  const host = normalizeHost(new URL(request.url).host) ?? "";
  if (LOCAL_HOST.test(host)) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return fetch(request);
}

export async function gateRequest(
  request: Request,
  url: URL,
  env: GateEnv | null | undefined,
  deps: GateDeps = {},
): Promise<GateResult> {
  const log = deps.log ?? ((label, detail) => console.error(label, detail));
  if (isValidationPath(url.pathname)) {
    return { kind: "validation", response: await (deps.passThrough ?? defaultPassThrough)(request) };
  }

  // The Host of the request itself; forwarded-host headers are never read.
  const host = normalizeHost(new URL(request.url).host);
  if (!host) return { kind: "refused", hostKind: "unknown", response: statePage("not-found", url.pathname) };

  const extra = typeof env?.PLATFORM_HOSTS === "string" ? env.PLATFORM_HOSTS : null;
  if (platformHosts(extra).has(host)) {
    // Platform host: only platform routes exist here; every tenant route is a 404.
    if (!isPlatformRoute(url.pathname)) {
      return { kind: "refused", hostKind: "platform", response: statePage("not-found", url.pathname) };
    }
    return { kind: "platform", host };
  }
  // Tenant host: platform routes do not exist here.
  if (isPlatformRoute(url.pathname)) {
    return { kind: "refused", hostKind: "tenant", response: statePage("not-found", url.pathname) };
  }

  const db = env?.PLATFORM_DB as D1Database | undefined;
  if (!db || typeof db.prepare !== "function") {
    log("gate-no-platform-db", { host_kind: "tenant" });
    return { kind: "refused", hostKind: "tenant", response: statePage("unavailable", url.pathname) };
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
  } catch (error) {
    // A control-plane read failure is a 503 for this tenant host (TD-2), never a default tenant.
    log("gate-platform-db-failed", { message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return { kind: "refused", hostKind: "tenant", response: statePage("unavailable", url.pathname) };
  }
}
