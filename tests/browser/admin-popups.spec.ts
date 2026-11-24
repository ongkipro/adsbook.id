// Every popup trigger on every admin page opens once (owner, 2026-11-24, after
// the Base UI move shipped account and order menus that did not open and no
// test noticed). Signed in as the seeded owner, at 1366 px, each page is
// visited and each visible, enabled trigger is clicked: menus, selects,
// comboboxes, dialogs and sheets, plus the plain buttons that load a menu on
// first click (aria-haspopup). Each must show its popup, close on Escape, and
// raise no page error or Base UI error. A trigger that opens nothing fails
// with its page and label.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const STORE = origin("toko-alfa");

const PAGES = [
  "/admin/dashboard", "/admin/orders", "/admin/orders/abandoned", "/admin/shipping", "/admin/check",
  "/admin/products", "/admin/products/new", "/admin/landing-pages", "/admin/landing-pages/new",
  "/admin/analytics", "/admin/analytics/products", "/admin/analytics/landing", "/admin/analytics/locations", "/admin/analytics/times", "/admin/analytics/utm",
  "/admin/ads", "/admin/ads/meta", "/admin/ads/google", "/admin/ads/tiktok", "/admin/ads/utm",
  "/admin/payments", "/admin/balance", "/admin/billing", "/admin/expeditions", "/admin/couriers",
  "/admin/settings", "/admin/settings/store", "/admin/settings/theme", "/admin/settings/theme/beranda", "/admin/settings/access",
  "/admin/settings/crm", "/admin/settings/developer", "/admin/settings/domains", "/admin/settings/plugins", "/admin/settings/warehouse",
  "/admin/settings/whatsapp", "/admin/settings/privacy", "/admin/profile", "/admin/status",
];

// Opens a popup: a Base UI trigger, or a stand-in button that loads one.
const TRIGGERS = [
  '[data-slot="dropdown-menu-trigger"]',
  '[data-slot="select-trigger"]',
  '[data-slot="combobox-trigger"]',
  '[data-slot="dialog-trigger"]',
  '[data-slot="sheet-trigger"]',
  'button[aria-haspopup="menu"]',
  'button[aria-haspopup="listbox"]',
  'button[aria-haspopup="dialog"]',
].join(", ");
const POPUPS = '[role="menu"], [role="listbox"], [role="dialog"], [data-slot="select-content"], [data-slot="combobox-content"]';

async function signIn(page: Page) {
  const { username, password } = owner("toko-alfa");
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

async function sweep(page: Page, pages: readonly string[]) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${page.url()} pageerror ${String(error).slice(0, 200)}`));
  page.on("console", (message) => {
    if (message.type() === "error" && /Base UI error|Minified React error|Hydration/i.test(message.text())) errors.push(`${page.url()} ${message.text().slice(0, 200)}`);
  });
  const failures: string[] = [];
  let opened = 0;
  for (const path of pages) {
    const response = await page.goto(`${STORE}${path}`);
    if (!response || response.status() >= 400 || !page.url().includes(path)) continue;
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")), null, { timeout: 15_000 }).catch(() => undefined);
    const count = await page.locator(TRIGGERS).count();
    for (let index = 0; index < count; index++) {
      const trigger = page.locator(TRIGGERS).nth(index);
      if (!(await trigger.isVisible().catch(() => false)) || (await trigger.isDisabled().catch(() => true))) continue;
      const name = ((await trigger.getAttribute("aria-label")) || (await trigger.innerText().catch(() => "")) || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const before = page.url();
      await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
      await trigger.click({ timeout: 5_000 }).catch((error) => failures.push(`${path} · "${name}": click failed (${String(error).split("\n")[0].slice(0, 80)})`));
      if (page.url() !== before) {
        failures.push(`${path} · "${name}": navigated instead of opening a popup`);
        await page.goto(`${STORE}${path}`);
        continue;
      }
      const popup = page.locator(POPUPS).filter({ visible: true }).first();
      const shown = await popup.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
      if (!shown) {
        failures.push(`${path} · "${name}": no popup appeared`);
        continue;
      }
      opened++;
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(POPUPS).filter({ visible: true }).count(), { timeout: 5_000 }).toBe(0).catch(() => failures.push(`${path} · "${name}": popup did not close on Escape`));
    }
  }
  return { errors, failures, opened };
}

test("every admin popup trigger opens its popup and closes (1366)", async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  const { errors, failures, opened } = await sweep(page, PAGES);
  console.log(`1366: opened ${opened} popups across ${PAGES.length} pages`);
  expect(errors, "no page or Base UI errors").toEqual([]);
  expect(failures, "every trigger opens and closes a popup").toEqual([]);
  expect(opened, "the sweep found triggers").toBeGreaterThan(20);
});

// A phone shows other controls: the bottom navigation's menu sheet, stacked
// filters. A shorter list of the pages operators use most.
test("admin popups open and close on a phone (390)", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const phonePages = ["/admin/dashboard", "/admin/orders", "/admin/shipping", "/admin/products", "/admin/payments", "/admin/settings/theme/beranda"];
  const { errors, failures, opened } = await sweep(page, phonePages);
  // The bottom navigation's "Menu" opens the full menu sheet.
  await page.goto(`${STORE}/admin/dashboard`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.getByRole("button", { name: "Buka semua menu" }).click();
  await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  console.log(`390: opened ${opened} popups across ${phonePages.length} pages`);
  expect(errors, "no page or Base UI errors").toEqual([]);
  expect(failures, "every trigger opens and closes a popup").toEqual([]);
  expect(opened).toBeGreaterThan(5);
});
