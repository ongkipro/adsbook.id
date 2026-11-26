// Tracking chapter 11, Phase 1: TikTok Pixel + Events API in a real browser.
//
// Proves, on a subscribed store:
//   1. /admin/ads shows three platform cards, and /admin/ads/tiktok saves a
//      pixel and a token; the token is never sent back to the browser.
//   2. A test event is refused without a Test Event Code (no billable test).
//   3. The storefront then mints a first-party `_ttp`, defers events.js from
//      analytics.tiktok.com (allowed by the CSP, no violation), and posts the
//      ViewContent server twin to /api/tiktok-event with the browser's event_id.
//   4. Cleared again, the storefront ships no TikTok code at all.
// TikTok's own origin is answered by a stub here: the suite never reaches it.
// Set TT_SHOT_DIR to keep the admin screenshots.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const store = TENANTS[1];
const base = origin(store.slug);
const PIXEL = "C4ABCDEFGHIJ1234";
const TOKEN = "tt-local-token-not-real-0001";
const shotDir = process.env.TT_SHOT_DIR;

async function signIn(page: Page) {
  const creds = owner(store.slug);
  await page.goto(`${base}/hello`);
  await page.getByLabel("Email atau username").fill(creds.username);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

test("TikTok Pixel + Events API: admin setup, storefront pixel and server twin, and nothing once cleared", async ({ browser }) => {
  const admin = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await admin.newPage();
  await signIn(page);

  await page.goto(`${base}/admin/ads`);
  await expect(page.locator("#tiktokBadge")).toHaveText("Belum lengkap");
  await expect(page.getByRole("link", { name: "Kelola TikTok" })).toBeVisible();
  await expect(page.locator("#adsChannels > article")).toHaveCount(3);

  await page.goto(`${base}/admin/ads/tiktok`);
  await expect(page.locator("#tiktokForm")).not.toHaveAttribute("inert", "");
  await page.locator("#tiktokPixelId").fill(PIXEL);
  await page.locator("#tiktokToken").fill(TOKEN);
  await page.getByRole("button", { name: "Simpan TikTok" }).click();
  await expect(page.locator("#tiktokStatus")).toHaveText(/berhasil disimpan/);
  await expect(page.locator("#tiktokBadge")).toHaveText("Terhubung");

  // ADR-040: the saved token is a flag and a mask, never the value.
  const config = await page.request.get(`${base}/api/admin/ads`);
  const body = await config.text();
  expect(body.includes(TOKEN)).toBe(false);
  expect(JSON.parse(body).data.tiktok).toMatchObject({ pixel_id: PIXEL, access_token_configured: true, cod_trigger: "order_created" });

  await page.getByRole("button", { name: "Kirim test event" }).click();
  await expect(page.locator("#testTikTokStatus")).toHaveText(/Test Event Code/);

  await page.goto(`${base}/admin/ads`);
  await expect(page.locator("#tiktokBadge")).toHaveText("Aktif");
  if (shotDir) await page.screenshot({ path: `${shotDir}/tt-admin-overview-1366.png`, fullPage: true });
  await page.goto(`${base}/admin/ads/tiktok`);
  await expect(page.locator("#tokenHint")).toHaveText("Tersimpan di server");
  if (shotDir) await page.screenshot({ path: `${shotDir}/tt-admin-page-1366.png`, fullPage: true });

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phone.newPage();
  await signIn(phonePage);
  await phonePage.goto(`${base}/admin/ads/tiktok`);
  await expect(phonePage.locator("#tiktokBadge")).toHaveText("Terhubung");
  expect(await phonePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  if (shotDir) await phonePage.screenshot({ path: `${shotDir}/tt-admin-page-390.png`, fullPage: true });
  await phone.close();

  // ---- The storefront, as an anonymous buyer ----
  const buyer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // If another spec leaves Google Ads configured, keep its live script from
  // running here. The TikTok CSP assertion still checks every violation.
  await buyer.route("https://www.googletagmanager.com/gtag/js?*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  const libraryRequests: string[] = [];
  await buyer.route("https://analytics.tiktok.com/**", (route) => {
    libraryRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/javascript", body: "window.__TT_STUB_LOADED__ = true;" });
  });
  const shop = await buyer.newPage();
  const violations: string[] = [];
  await shop.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const serverTwin = shop.waitForRequest((request) => request.url().endsWith("/api/tiktok-event") && request.method() === "POST");
  await shop.goto(`${base}/`);
  const productHref = await shop.locator('a[href^="/produk/"]').first().getAttribute("href");
  expect(productHref, "the seeded store lists a product").toBeTruthy();
  // ADR-029: anonymous HTML may sit in the two-minute edge cache; a fresh
  // non-tracking parameter is a fresh cache key, so this reads the saved setting.
  await shop.goto(`${base}${productHref}?cb=tt-on&ttclid=E_C_P_BROWSER_1`);

  const twin = await serverTwin;
  const twinBody = JSON.parse(twin.postData() ?? "{}");
  expect(twinBody.event).toBe("ViewContent");
  expect(twinBody.event_id).toMatch(/^vc_/);
  const twinResponse = await twin.response();
  expect(twinResponse?.status(), "the server twin is accepted (queued or delivered)").toBe(200);

  const ttp = (await buyer.cookies(base)).find((cookie) => cookie.name === "_ttp");
  expect(ttp?.value, "a first-party _ttp is minted before events.js").toMatch(/^[A-Za-z0-9]{27}$/);
  const clickIds = (await buyer.cookies(base)).find((cookie) => cookie.name === "adsbook_click_ids");
  expect(decodeURIComponent(clickIds?.value ?? "")).toContain('"ttclid":"E_C_P_BROWSER_1"');

  await shop.waitForTimeout(2800);
  expect(libraryRequests.some((url) => url.startsWith("https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C4ABCDEFGHIJ1234&lib=ttq"))).toBe(true);
  expect(await shop.evaluate(() => (window as unknown as { __TT_STUB_LOADED__?: boolean }).__TT_STUB_LOADED__)).toBe(true);
  violations.push(...(await shop.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])));
  expect(violations, "no CSP violation").toEqual([]);

  // ---- Cleared: zero TikTok bytes ----
  // From the admin page itself, as its own script calls the API (same-origin, CSRF-checked).
  const cleared = await page.evaluate(async () => {
    const response = await fetch("/api/admin/ads", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save-tiktok", tiktok_clear: true }),
    });
    return response.status;
  });
  expect(cleared).toBe(200);
  const fresh = await browser.newContext();
  const after = await fresh.request.get(`${base}${productHref}?cb=tt-off`);
  const html = await after.text();
  expect(html.includes("analytics.tiktok.com")).toBe(false);
  // The pixel base (stub, _ttp minting, loader) is gone; the landing tracker's
  // optional `__PS_TIKTOK_TRACK__?.()` call stays, and is then a no-op.
  expect(html.includes("TiktokAnalyticsObject")).toBe(false);
  expect(html.includes("_ttp=")).toBe(false);
  await fresh.close();
  await buyer.close();
  await admin.close();
});
