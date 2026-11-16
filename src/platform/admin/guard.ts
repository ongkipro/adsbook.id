/**
 * The platform-host gate for platform admin (IAM-3, IAM-5, TEN-6): every
 * `/platform/*` page and `/api/platform/*` call needs a platform session,
 * except the public signup and sign-in surfaces. Unsafe calls also need the
 * strict same-origin rule. A tenant session is never read here.
 */
import { BROWSER_UNSUPPORTED_MESSAGE, unsafeRequestVerdict } from "../../lib/auth.ts";
import { resolvePlatformUser, type PlatformUser } from "./session.ts";

const PUBLIC = new Set(["/platform/signup", "/platform/login", "/platform/syarat", "/platform/privasi", "/api/platform/signup", "/api/platform/slug", "/api/platform/login"]);
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuardResult = { kind: "pass"; user: PlatformUser | null } | { kind: "deny"; response: Response };

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });

export async function platformGuard(request: Request, url: URL, env: Record<string, unknown>): Promise<GuardResult> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const isApi = path === "/api/platform" || path.startsWith("/api/platform/");
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
  if (PUBLIC.has(path)) return { kind: "pass", user: null };
  const user = await resolvePlatformUser(env, request);
  if (user) return { kind: "pass", user };
  return {
    kind: "deny",
    response: isApi
      ? json(401, { success: false, error: "Unauthorized" })
      : new Response(null, { status: 302, headers: { location: "/platform/login", "cache-control": "private, no-store" } }),
  };
}
