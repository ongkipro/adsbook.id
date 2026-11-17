// Paduka (2026-11-17): "waktu aku klik pengaturan -> akses penguna, sidebar
// tidak stay dan kegeser ke atas. harusnya stay di posisinya biar tau menu x
// halamanya nya presisi … kadang efek glitch, getar, dll".
//
// Proves in Chromium, at desktop (1366x720, where the sidebar scrolls) and
// mobile (390x844):
//   1. Clicking Pengaturan → Akses Pengguna (and the neighbouring bottom
//      submenu items) leaves the clicked item at the same y-coordinate on the
//      next page — within 2 px — and visible inside the sidebar.
//   2. On mobile, opening "Semua menu" on /admin/settings/access scrolls the
//      sheet so "Akses Pengguna" is in view.
//   3. Cold-loading the pages that used to shift (domains, developer, profile,
//      landing-pages, settings, ads/utm, payments, orders) produces CLS <= 0.005.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const store = TENANTS[0];

async function signIn(page: Page) {
  const creds = owner(store.slug);
  await page.goto(`${origin(store.slug)}/hello`);
  await page.getByLabel("Email atau username").fill(creds.username);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

test("the sidebar stays where the operator clicked, and admin pages load without layout shift", async ({ browser }) => {
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 720 } });
  await desktop.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const page = await desktop.newPage();
  await signIn(page);

  await page.goto(`${origin(store.slug)}/admin/settings`);
  await page.waitForLoadState("networkidle");

  for (const href of ["/admin/settings/access", "/admin/settings/plugins", "/admin/settings/warehouse", "/admin/settings/domains"]) {
    const link = page.locator(`[data-sidebar="content"] a[href="${href}"]`);
    await link.scrollIntoViewIfNeeded();
    const beforeY = await link.evaluate((el) => Math.round(el.getBoundingClientRect().top));
    await Promise.all([page.waitForURL(`**${href}`), link.click()]);
    await page.waitForLoadState("networkidle");

    const after = await page.evaluate((target) => {
      const content = document.querySelector('[data-sidebar="content"]')!;
      const active = content.querySelector(`a[href="${target}"]`)!;
      const item = active.getBoundingClientRect();
      const box = content.getBoundingClientRect();
      return {
        y: Math.round(item.top),
        ariaCurrent: active.getAttribute("aria-current"),
        visible: item.top >= box.top && item.bottom <= box.bottom,
      };
    }, href);
    expect(after.ariaCurrent, `${href} is marked current`).toBe("page");
    expect(after.visible, `${href} stays in view in the sidebar`).toBe(true);
    expect(Math.abs(after.y - beforeY), `${href} stays under the pointer`).toBeLessThanOrEqual(2);
  }

  for (const path of [
    "/admin/settings/domains",
    "/admin/settings/developer",
    "/admin/profile",
    "/admin/landing-pages",
    "/admin/settings",
    "/admin/ads/utm",
    "/admin/payments",
    "/admin/orders",
  ]) {
    await page.goto(`${origin(store.slug)}${path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls, `${path} cumulative layout shift`).toBeLessThanOrEqual(0.005);
  }
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobile.newPage();
  await signIn(mPage);
  await mPage.goto(`${origin(store.slug)}/admin/settings/access`);
  await mPage.waitForLoadState("networkidle");
  await mPage.getByRole("button", { name: "Buka menu navigasi" }).click();
  const visibleInSheet = await mPage.evaluate(() => {
    const current = document.querySelector('[data-slot="sheet-content"] [aria-current="page"]');
    const scroller = current?.closest("[data-menu-scroll]");
    if (!current || !scroller) return false;
    const item = current.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    return item.top >= box.top && item.bottom <= Math.min(box.bottom, window.innerHeight);
  });
  expect(visibleInSheet, "mobile menu opens with Akses Pengguna in view").toBe(true);
  await mobile.close();
});
