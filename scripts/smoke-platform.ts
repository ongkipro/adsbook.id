/**
 * `npm run smoke:platform` — read-only checks after a platform deploy. It never
 * writes, signs in, or sends mail; every request is a public GET or HEAD except
 * one read of the seller zone's Worker routes.
 *
 * Checks:
 * 1. The seller zone (`CF_SAAS_ZONE_ID`) routes only to this Worker. On
 *    2026-11-22 a foreign `*adsbook.my.id/*` route took every store request and
 *    answered 522 for four hours while the platform hosts looked healthy.
 *    Needs a token with Workers Routes read on that zone in `CF_ROUTES_READ_TOKEN`
 *    (or `CF_SAAS_TOKEN`); without one the check is reported as skipped, never
 *    as passed.
 * 2. Public pages answer: the site, sign-in, signup, password reset, the slug
 *    check, a store's sign-in page, and the seller apex redirect.
 * 3. Plain HTTP moves to HTTPS on a platform host and on a store host.
 *
 *   npm run smoke:platform -- [--store=demo]
 *
 * Exit 1 on any failed check. Run it with `secrets-env run --` so the token is
 * never typed.
 */
import { readFileSync } from "node:fs";
import { foreignZoneRoutes, parseWranglerConfig, type ZoneRoute } from "../src/lib/deploy-preflight.ts";

const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const worker = String(parseWranglerConfig(source).name ?? "");
// The seller zone id is a public var of the same config (`vars.CF_SAAS_ZONE_ID`).
const zoneId = source.match(/"CF_SAAS_ZONE_ID"\s*:\s*"([0-9a-f]{32})"/)?.[1] ?? "";
const store = process.argv.find((arg) => arg.startsWith("--store="))?.split("=")[1] || "demo";
const SITE = "adsbook.id";
const SELLER = "adsbook.my.id";

let failed = 0;
const ok = (label: string, detail = "") => console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
const bad = (label: string, detail: string) => {
  failed += 1;
  console.error(`  ✖ ${label}: ${detail}`);
};

async function head(url: string, method = "GET") {
  const response = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

async function expectStatus(label: string, url: string, statuses: number[], location?: string) {
  try {
    const got = await head(url);
    if (!statuses.includes(got.status)) return bad(label, `${got.status} (expected ${statuses.join("/")})`);
    if (location !== undefined && got.location !== location) return bad(label, `Location ${got.location || "(none)"} (expected ${location})`);
    ok(label, `${got.status}${got.location ? ` → ${got.location}` : ""}`);
  } catch (error) {
    bad(label, error instanceof Error ? error.message : String(error));
  }
}

console.log(`[smoke] ${worker}: seller zone routes`);
const token = process.env.CF_ROUTES_READ_TOKEN || process.env.CF_SAAS_TOKEN || "";
if (!zoneId || !token) {
  console.warn("  - skipped: no CF_SAAS_ZONE_ID in wrangler.jsonc or no read token in the environment (NOT a pass)");
} else {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: ZoneRoute[] };
    if (!response.ok || !body.success) bad("route list", `HTTP ${response.status}`);
    else {
      const foreign = foreignZoneRoutes(body.result ?? [], worker);
      if (foreign.length) bad("only this Worker routes the seller zone", foreign.map((route) => `${route.pattern} → ${route.script ?? "(none)"}`).join(", "));
      else ok("only this Worker routes the seller zone", (body.result ?? []).map((route) => route.pattern).join(", "));
    }
  } catch (error) {
    bad("route list", error instanceof Error ? error.message : String(error));
  }
}

console.log("[smoke] public pages");
await expectStatus("site home", `https://${SITE}/`, [200]);
await expectStatus("sign-in /masuk", `https://${SITE}/masuk`, [200]);
await expectStatus("signup /daftar", `https://${SITE}/daftar`, [200]);
await expectStatus("password reset /lupa-password", `https://${SITE}/lupa-password`, [200]);
await expectStatus("slug check", `https://${SITE}/api/platform/slug?slug=smoke-check-${Date.now().toString(36)}`, [200]);
await expectStatus(`store ${store} sign-in`, `https://${store}.${SELLER}/hello`, [200]);
await expectStatus(`store ${store} home`, `https://${store}.${SELLER}/`, [200, 503]);
await expectStatus("seller apex", `https://${SELLER}/`, [301], `https://${SITE}/`);

console.log("[smoke] HTTPS");
await expectStatus("platform http → https", `http://${SITE}/masuk`, [301, 302], `https://${SITE}/masuk`);
await expectStatus("store http → https", `http://${store}.${SELLER}/hello`, [301, 302], `https://${store}.${SELLER}/hello`);

if (failed) {
  console.error(`\n[smoke] ${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\n[smoke] all checks passed.");
