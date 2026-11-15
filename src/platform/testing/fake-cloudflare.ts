/**
 * A stand-in for Cloudflare for SaaS's custom-hostname API
 * (`/zones/{zone}/custom_hostnames`), for tests and local development only.
 * It speaks the same JSON envelope (`success`, `errors`, `result`), so the
 * real client in `src/platform/hostnames.ts` is what talks to it.
 */
export type FakeHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; method: string; type: string; validation_errors?: Array<{ message: string }> };
  verification_errors?: string[];
};

export function createFakeCloudflare(options: { zoneId?: string; token?: string } = {}) {
  const zoneId = options.zoneId ?? "zone-test";
  const token = options.token ?? "token-test";
  const hostnames = new Map<string, FakeHostname>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  /** Hosts Cloudflare refuses to create, with the error it answers. */
  const refuse = new Map<string, { code: number; message: string }>();
  let next = 1;

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ok = (result: unknown) => reply(200, { success: true, errors: [], messages: [], result });
  const fail = (status: number, code: number, message: string) =>
    reply(status, { success: false, errors: [{ code, message }], messages: [], result: null });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json().catch(() => null);
    calls.push({ method: request.method, path: url.pathname, body });
    if (request.headers.get("authorization") !== `Bearer ${token}`) return fail(403, 10000, "Authentication error");
    const match = url.pathname.match(/\/zones\/([^/]+)\/custom_hostnames(?:\/([^/]+))?$/);
    if (!match || match[1] !== zoneId) return fail(404, 7003, "Could not route to zone");
    const id = match[2];
    if (!id && request.method === "GET") {
      const wanted = url.searchParams.get("hostname");
      return ok([...hostnames.values()].filter((entry) => !wanted || entry.hostname === wanted));
    }
    if (!id && request.method === "POST") {
      const hostname = String((body as { hostname?: string })?.hostname ?? "");
      const refusal = refuse.get(hostname);
      if (refusal) return fail(400, refusal.code, refusal.message);
      if ([...hostnames.values()].some((entry) => entry.hostname === hostname)) {
        return fail(409, 1406, "Duplicate custom hostname found.");
      }
      const entry: FakeHostname = {
        id: `cf-${next++}`,
        hostname,
        status: "pending",
        ssl: { status: "initializing", method: "http", type: "dv" },
        verification_errors: ["custom hostname does not CNAME to this zone."],
      };
      hostnames.set(entry.id, entry);
      return ok(entry);
    }
    const entry = id ? hostnames.get(id) : undefined;
    if (!entry) return fail(404, 1436, "Custom hostname not found.");
    if (request.method === "GET") return ok(entry);
    if (request.method === "PATCH") return ok(entry);
    if (request.method === "DELETE") {
      hostnames.delete(entry.id);
      return ok({ id: entry.id });
    }
    return fail(405, 10405, "Method not allowed");
  }

  return {
    zoneId,
    token,
    hostnames,
    calls,
    refuse,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
    handle,
    byHost: (hostname: string) => [...hostnames.values()].find((entry) => entry.hostname === hostname),
    /** The seller pointed DNS and the certificate issued. */
    activate(hostname: string, ssl = "active") {
      const entry = [...hostnames.values()].find((candidate) => candidate.hostname === hostname);
      if (!entry) throw new Error(`no fake hostname ${hostname}`);
      entry.status = "active";
      entry.ssl.status = ssl;
      entry.verification_errors = [];
    },
  };
}
