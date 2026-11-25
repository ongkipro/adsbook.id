// Spec A Phase 2 (T-9) + Base URL UI cleanup:
// 1. /admin/profile and /admin/settings never show Mengantar/AutoLaris Base URL inputs or api-public.mengantar.com.
// 2. Owner issues a one-time Mengantar webhook URL, saves a sealed Webhook Secret,
//    reloads, and confirms the raw secret never appears in HTML or /api/admin/settings.
// 3. Zero horizontal overflow at 1366px and 390px, and /admin/shipping shows auto-sync active.
import { expect, test } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);

test("T-9 & Base URL cleanup: owner configures Mengantar webhook on /admin/profile without Base URL clutter", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const { username, password } = owner(SLUG);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);

  // 1. /admin/settings must not display api-public.mengantar.com or #mengantarUrl
  await page.goto(`${STORE}/admin/settings`);
  await expect(page.locator("#mengantarBadge")).not.toHaveText("Memuat", { timeout: 10_000 });
  await expect(page.locator("#mengantarUrl")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("api-public.mengantar.com");

  // 2. /admin/profile must not display Base URL inputs for Mengantar or AutoLaris
  await page.goto(`${STORE}/admin/profile`);
  await expect(page.locator("#mengantarKey")).toBeVisible();
  await expect(page.locator("#mengantarUrl")).toHaveCount(0);
  await expect(page.locator("#autolarisUrl")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("api-public.mengantar.com");
  await expect(page.locator("body")).not.toContainText("api-h2h.autolaris.com");

  // 3. Issue one-time Mengantar webhook URL
  await page.locator("#issueMengantarWebhook").click();
  await expect(page.locator("#mengantarWebhookWrap")).toBeVisible({ timeout: 10_000 });
  const issuedUrl = (await page.locator("#mengantarWebhookUrl").textContent())?.trim() ?? "";
  expect(issuedUrl).toMatch(/\/api\/webhooks\/mengantar\/[0-9a-f]{64}$/);

  // 4. Save Webhook Secret and verify zero plaintext echo in HTML or API JSON after reload
  const rawSecret = "whsec-browser-rahasia-987654321";
  await page.locator("#mengantarWebhookSecret").fill(rawSecret);
  await page.locator("#saveIntegrations").click();
  await expect(page.locator("#saveStatus")).toContainText("berhasil disimpan", { timeout: 10_000 });

  await page.reload();
  await expect(page.locator("#mengantarWebhookState")).toContainText("Aktif", { timeout: 10_000 });
  const pageHtml = await page.content();
  expect(pageHtml.includes(rawSecret)).toBe(false);
  const settingsJson = await (await page.request.get(`${STORE}/api/admin/settings`)).text();
  expect(settingsJson.includes(rawSecret)).toBe(false);
  expect(JSON.parse(settingsJson).data.credentials.mengantar.webhook_secret_configured).toBe(true);

  // 5. Desktop (1366px): clicking left rail section links must scroll #admin-main only
  //    and keep the sticky rail cleanly below the top header (never clipped/overlapping).
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(desktopOverflow).toBeLessThanOrEqual(1);

  const shotsDir = process.env.CAPTURE_PROFILE_SHOTS_DIR;
  if (shotsDir) {
    await page.screenshot({ path: `${shotsDir}/profile-desktop-top.png` });
  }

  await page.locator('nav[aria-label="Menu profil"] a[href="#integrasi-mengantar"]').click();
  await page.waitForTimeout(350);
  const stickyMetrics = await page.evaluate(() => {
    const header = document.querySelector("header.admin-topbar");
    const aside = document.querySelector("aside");
    const main = document.getElementById("admin-main");
    return {
      headerTop: header?.getBoundingClientRect().top ?? -1,
      headerBottom: header?.getBoundingClientRect().bottom ?? -1,
      asideTop: aside?.getBoundingClientRect().top ?? -1,
      bodyScrollTop: document.body.scrollTop,
      docScrollTop: document.documentElement.scrollTop,
      mainScrollTop: main?.scrollTop ?? 0,
    };
  });
  expect(stickyMetrics.headerTop).toBe(0);
  expect(stickyMetrics.bodyScrollTop).toBe(0);
  expect(stickyMetrics.docScrollTop).toBe(0);
  expect(stickyMetrics.mainScrollTop).toBeGreaterThan(0);
  expect(stickyMetrics.asideTop).toBeGreaterThanOrEqual(stickyMetrics.headerBottom - 1);

  if (shotsDir) {
    await page.screenshot({ path: `${shotsDir}/profile-desktop-scrolled.png` });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(mobileOverflow).toBeLessThanOrEqual(1);
  if (shotsDir) {
    await page.screenshot({ path: `${shotsDir}/profile-mobile-390.png`, fullPage: true });
  }

  // 6. A-6: /admin/shipping shows auto-sync active indicator
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${STORE}/admin/shipping`);
  await expect(page.getByText(/Sinkron otomatis aktif/)).toBeVisible({ timeout: 10_000 });

  // Clean up test webhook secret so sibling browser specs see clean state
  await page.goto(`${STORE}/admin/profile`);
  await page.locator('input[name="mengantar_clear_webhook_secret"]').check();
  await page.locator("#saveIntegrations").click();
  await expect(page.locator("#saveStatus")).toContainText("berhasil disimpan", { timeout: 10_000 });

  expect(consoleErrors).toEqual([]);
});
