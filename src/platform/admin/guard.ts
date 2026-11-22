/**
 * The platform-host gate for platform admin (IAM-3, IAM-5, TEN-6): every
 * `/platform/*` page and `/api/platform/*` call needs a platform session,
 * except the public signup and sign-in surfaces. Unsafe calls also need the
 * strict same-origin rule. A tenant session is never read here.
 */
import { BROWSER_UNSUPPORTED_MESSAGE, unsafeRequestVerdict } from "../../lib/auth.ts";
import { resolvePlatformUser, type PlatformUser } from "./session.ts";

/** Platform paths reachable without a platform session (also read by the route map). */
export const PLATFORM_PUBLIC_PATHS: ReadonlySet<string> = new Set(["/platform/signup", "/platform/masuk", "/platform/login", "/platform/syarat", "/platform/privasi", "/api/platform/signup", "/api/platform/slug", "/api/platform/login", "/api/platform/masuk", "/platform/akses", "/api/platform/akses"]);

/** Whether a platform path is public: the signup and sign-in surfaces and the marketing site (T-40). */
/**
 * Provider callbacks to the platform (API-9): a server POST with no Origin and
 * no session, authenticated by the secret token in its own path.
 */
export function isPlatformWebhookPath(pathname: string): boolean {
  return /^\/api\/platform\/webhooks\/autolaris\/[^/]+\/?$/.test(pathname);
}

export function isPlatformPublicPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return PLATFORM_PUBLIC_PATHS.has(path) || path === "/platform/site" || path.startsWith("/platform/site/");
}
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuardResult = { kind: "pass"; user: PlatformUser | null } | { kind: "deny"; response: Response };

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });

export async function platformGuard(request: Request, url: URL, env: Record<string, unknown>): Promise<GuardResult> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const isApi = path === "/api/platform" || path.startsWith("/api/platform/");
  if (request.method === "POST" && isPlatformWebhookPath(path)) return { kind: "pass", user: null };
  // Strict CSRF for every unsafe call, the public sign-in and signup included:
  // being reachable without a session is no exemption from IAM-5.
  if (UNSAFE.has(request.method)) {
    const verdict = unsafeRequestVerdict(request, url);
    if (verdict !== "allowed") {
      return {
        kind: "deny",
        response: json(403, verdict === "browser_unsupported"
          ? { success: false, error: BROWSER_UNSUPPORTED_MESSAGE, code: "browser_unsupported" }
          : { success: false, error: "Forbidden request origin", code: "forbidden_origin" }),
      };
    }
  }
  // The marketing site (T-40) is public: its pages render under /platform/site.
  if (isPlatformPublicPath(path)) return { kind: "pass", user: null };
  const user = await resolvePlatformUser(env, request);
  if (user) return { kind: "pass", user };
  return {
    kind: "deny",
    response: isApi
      ? json(401, { success: false, error: "Unauthorized" })
      : new Response(null, { status: 302, headers: { location: "/platform/login", "cache-control": "private, no-store" } }),
  };
}
