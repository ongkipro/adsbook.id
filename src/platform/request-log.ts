/**
 * One structured line per request (OBS-1). `route` is the matched route
 * pattern, never the raw path or query: webhook tokens are path segments and
 * storefront URLs can carry buyer identifiers. Cloudflare's invocation logs,
 * which record the full URL, are off in `wrangler.jsonc`.
 */
export type HostKind = "tenant" | "platform" | "unknown" | "validation";

export type RequestLogLine = {
  event: "request";
  tenant_id: string | null;
  host_kind: HostKind;
  route: string;
  method: string;
  status: number;
  duration_ms: number;
  request_id: string;
  /** A fixed code when the gate refused or the handler threw; never free text from a request. */
  reason?: string;
};

/** Anything that is not a route pattern is reduced to a fixed label. */
export function routeLabel(routePattern: string | undefined | null, fallback: string): string {
  if (!routePattern || !routePattern.startsWith("/") || /[?#]/.test(routePattern)) return fallback;
  return routePattern;
}

const requestIds = new WeakMap<Request, string>();

/** Stable per request: the request line and any error line below it carry the same id. */
export function requestId(request: Request): string {
  let id = requestIds.get(request);
  if (!id) {
    const ray = request.headers.get("cf-ray");
    id = ray && /^[a-z0-9-]{1,64}$/i.test(ray) ? ray : crypto.randomUUID();
    requestIds.set(request, id);
  }
  return id;
}

export function buildRequestLog(fields: Omit<RequestLogLine, "event">): RequestLogLine {
  return { event: "request", ...fields };
}

export function writeRequestLog(line: RequestLogLine, sink: (text: string) => void = console.log): void {
  sink(JSON.stringify(line));
}

/**
 * Correlation for an error line written below the middleware (OBS-1): the
 * request's own id, the tenant and its host name. Never a URL, cookie or token.
 */
export type LogContext = { request_id: string; tenant_id: string | null; host: string | null };

/**
 * A fixed code, never the thrown text: a driver message can quote SQL, a bound
 * value or a token. Cross-request I/O keeps its own code while it is open.
 */
export type ErrorCode = "cross_request_io" | "unexpected";

export function errorCode(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot perform i\/o on behalf of a different request/i.test(message) ? "cross_request_io" : "unexpected";
}

export type ErrorLogLine = LogContext & { event: string; operation: string; error_code: ErrorCode };

/** `event` and `operation` are fixed labels at the call site. */
export function buildErrorLog(
  event: string,
  operation: string,
  context: LogContext | undefined,
  error: unknown,
): ErrorLogLine {
  return {
    event,
    operation,
    request_id: context?.request_id ?? "unknown",
    tenant_id: context?.tenant_id ?? null,
    host: context?.host ?? null,
    error_code: errorCode(error),
  };
}
