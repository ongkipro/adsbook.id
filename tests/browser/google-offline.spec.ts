// Google Ads Phase 2 (tracking chapter 11 §3): the server-conversion card on /admin/ads/google.
// Proves, in a real browser at 1366 and 390: the Data Manager API is the default and hides the
// developer token; choosing the legacy Ads API shows it; the COD trigger defaults to delivered;
// "Uji koneksi server" with nothing saved explains what to do instead of calling Google.
// Set GDM_SHOT_DIR to keep the screenshots.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const store = TENANTS[0];
const base = origin(store.slug);
const shotDir = process.env.GDM_SHOT_DIR;

async function signIn(page: Page) {
  const creds = owner(store.slug);
  await page.goto(`${base}/hello`);
  await page.getByLabel("Email atau username").fill(creds.username);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

for (const [width, height] of [[1366, 900], [390, 844]] as const) {
  test(`Google server conversions card at ${width}px: Data Manager by default, no developer token, honest test button`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await signIn(page);
    await page.goto(`${base}/admin/ads/google`);
    const form = page.locator("#offlineForm");
    await expect(form).not.toHaveAttribute("inert", "");
    await expect(form.locator('input[name="api_mode"][value="data_manager"]')).toBeChecked();
    await expect(form.locator('input[name="cod_trigger"][value="delivered"]')).toBeChecked();
    await expect(form.locator("[data-developer-token]")).toBeHidden();
    await form.getByText("Google Ads API (legacy)").click();
    await expect(form.locator("[data-developer-token]")).toBeVisible();
    await form.getByText("Data Manager API (rekomendasi)").click();
    await expect(form.locator("[data-developer-token]")).toBeHidden();

    await page.getByRole("button", { name: "Uji koneksi server" }).click();
    // A provider-shaped round trip; under the full suite it can outlast the 5 s default.
    await expect(page.locator("#testOfflineStatus")).toHaveText(/Lengkapi dan simpan semua kolom wajib/, { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    if (shotDir) {
      await form.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shotDir}/gdm-admin-${width}.png`, fullPage: width > 400 });
    }
    await context.close();
  });
}
