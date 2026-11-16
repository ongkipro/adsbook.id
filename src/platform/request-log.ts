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

export function requestId(request: Request): string {
  const ray = request.headers.get("cf-ray");
  return ray && /^[a-z0-9-]{1,64}$/i.test(ray) ? ray : crypto.randomUUID();
}

export function buildRequestLog(fields: Omit<RequestLogLine, "event">): RequestLogLine {
  return { event: "request", ...fields };
}

export function writeRequestLog(line: RequestLogLine, sink: (text: string) => void = console.log): void {
  sink(JSON.stringify(line));
}
