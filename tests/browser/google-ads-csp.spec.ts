// Google Ads remarketing under the storefront CSP (2026-11-24). gtag.js loads
// googleads.g.doubleclick.net/pagead/viewthroughconversion/<id>/ as a script;
// the storefront policy refused it on every store with an Ads conversion id
// (CI run 45361586352, then measured locally two of two). A fresh buyer on a
// product page with a conversion id must now raise no CSP violation, and the
// admin keeps its own policy with no script or connect allowance.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const store = TENANTS[1];
const base = origin(store.slug);

async function signIn(page: Page) {
  const { username, password } = owner(store.slug);
  await page.goto(`${base}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

test("Google Ads loads its remarketing script under the storefront CSP; the admin CSP is unchanged", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const saveGoogle = (conversionId: string, label: string) =>
    page.evaluate(
      async ([id, lbl]) =>
        (
          await fetch("/api/admin/ads", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "save-google", google_tag_manager_id: "", google_ads_conversion_id: id, google_ads_conversion_label: lbl }),
          })
        ).status,
      [conversionId, label] as const,
    );

  // The admin's own response: its policy, not the storefront's.
  const adminResponse = await page.goto(`${base}/admin/ads`);
  const adminCsp = adminResponse!.headers()["content-security-policy"] ?? "";
  expect(adminCsp).toBe("frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");

  expect(await saveGoogle("AW-1234567890", "AbCdEfGh")).toBe(200);
  try {
    const buyer = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const shop = await buyer.newPage();
    const scripts: string[] = [];
    shop.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await shop.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { __violations: string[] }).__violations ??= [];
        (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await shop.goto(`${base}/`);
    const href = await shop.locator('a[href^="/produk/"]').first().getAttribute("href");
    // A fresh query is a fresh edge-cache key (ADR-029), so the saved id is read.
    const product = await shop.goto(`${base}${href}?cb=gads-${Date.now()}&gclid=TEST_GCLID_CSP`);
    const storefrontCsp = product!.headers()["content-security-policy"] ?? "";
    expect(storefrontCsp).toMatch(/script-src [^;]* https:\/\/googleads\.g\.doubleclick\.net[ ;]/);
    expect(storefrontCsp).not.toMatch(/script-src [^;]*\*\.(g\.)?doubleclick\.net/);
    // gtag requests the remarketing script once the page is idle.
    await expect.poll(() => scripts.some((url) => url.startsWith("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1234567890/")), { timeout: 15_000 }).toBe(true);
    await shop.waitForTimeout(1500);
    const violations = await shop.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []);
    expect(violations, "no CSP violation with Google Ads on").toEqual([]);
    await buyer.close();
  } finally {
    expect(await saveGoogle("", "")).toBe(200);
  }
});
