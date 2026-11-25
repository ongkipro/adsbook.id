/**
 * The demo store (T-41, PR-26): one tenant (`demo`, flag `is_demo`) that
 * shows the storefront and never talks to a provider.
 *
 * It bypasses the PR-23 readiness gate for browsing only, and the middleware
 * calls `demoRefusal` first, before any route runs or any provider client is
 * built. Default deny: every unsafe request is refused except signing in and
 * out (so an operator can still look at the admin), and the read-only routes
 * that would ask a provider (district search, shipping quotes, payment
 * methods, headless geo) are refused too. No order, quote, CAPI event,
 * Kelola sync, custom-hostname call or AI draft can start from the demo.
 */

/** Unsafe requests the demo still answers: the owner's way in and out. */
const DEMO_UNSAFE_ALLOWED = new Set(["/hello", "/api/admin/logout", "/api/handoff"]);

/** Read-only routes that would reach a provider (PR-26's list, GET side). */
const DEMO_PROVIDER_READS = [
  "/api/locations",
  "/api/shipping-rates",
  "/api/shipping-options",
  "/api/payment-methods",
  "/api/v1/geo",
  "/api/admin/check",
  "/api/admin/ongkir",
];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const DEMO_MESSAGE = "Ini toko contoh adsbook.id. Pemesanan, ongkir, dan pembayaran tidak aktif di toko ini.";

/** The refusal for a demo-store request, or null when it may proceed. */
export function demoRefusal(pathname: string, method: string): Response | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const providerRead = DEMO_PROVIDER_READS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const unsafe = UNSAFE.has(method.toUpperCase()) && !DEMO_UNSAFE_ALLOWED.has(path);
  if (!providerRead && !unsafe) return null;
  return new Response(JSON.stringify({ success: false, error: DEMO_MESSAGE, code: "DEMO_STORE" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
