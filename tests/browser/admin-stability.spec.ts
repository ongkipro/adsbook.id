// Paduka (2026-11-17): "waktu aku klik pengaturan -> akses penguna, sidebar
// tidak stay dan kegeser ke atas. harusnya stay di posisinya biar tau menu x
// halamanya nya presisi … kadang efek glitch, getar, dll".
//
// Proves in Chromium, at desktop (1366x720, where the sidebar scrolls) and
// mobile (390x844):
//   1. Clicking Pengaturan → Akses Pengguna (and the neighbouring bottom
//      submenu items) leaves the clicked item at the same y-coordinate on the
//      next page — within 2 px — and visible inside the sidebar. The same holds
//      for the standalone Plugin link, clicked from a Pengaturan page: it sits
//      right above Pengaturan, so Pengaturan's sub-list closing does not move it.
//   2. On mobile, opening "Semua menu" on /admin/settings/access scrolls the
//      sheet so "Akses Pengguna" is in view.
//   3. Cold-loading the pages that used to shift (domains, developer, profile,
//      landing-pages, settings, ads/utm, ads, ads/tiktok, payments, orders)
//      produces CLS <= 0.005.
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
      for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const page = await desktop.newPage();
  await signIn(page);

  await page.goto(`${origin(store.slug)}/admin/settings`);
  await page.waitForLoadState("networkidle");

  // Pengaturan's own sub-list (Plugin is its own workspace now, checked right after).
  for (const href of ["/admin/settings/access", "/admin/settings/warehouse", "/admin/settings/domains"]) {
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

  // From a Pengaturan page (its sub-list open below it), the standalone Plugin link: same geometry rules.
  {
    const href = "/admin/settings/plugins";
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
        settingsChildren: content.querySelectorAll('a[href="/admin/settings/domains"]').length,
      };
    }, href);
    expect(after.ariaCurrent, "Plugin is marked current").toBe("page");
    expect(after.visible, "Plugin stays in view in the sidebar").toBe(true);
    expect(Math.abs(after.y - beforeY), "Plugin stays under the pointer").toBeLessThanOrEqual(2);
    expect(after.settingsChildren, "Pengaturan's sub-list closes on the Plugin workspace").toBe(0);
    // That restore padded the menu's foot (the real script's seller path), before first paint: no layout shift.
    const restorePad = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-restore-pad").trim());
    expect(restorePad, "the restore needed the seller pad here").toMatch(/^[1-9]\d*px$/);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls, "Plugin navigation cumulative layout shift").toBeLessThanOrEqual(0.005);
    if (process.env.PLUGINS_SHOT_DIR) await page.screenshot({ path: `${process.env.PLUGINS_SHOT_DIR}/sidebar-plugin-from-settings-1366x720.png` });
  }

  // A shorter window than when the link was clicked: the restore keeps the clicked link in the clear area above
  // the footer card instead of its old, now off-screen, distance. A real click's saved place, then a shorter viewport.
  {
    await page.goto(`${origin(store.slug)}/admin/settings/domains`);
    await page.waitForLoadState("networkidle");
    const link = page.locator('[data-sidebar="content"] a[href="/admin/settings/plugins"]');
    await link.scrollIntoViewIfNeeded();
    await link.evaluate((el) => {
      // Where a click on a tall window would have saved it: further down than a 560px window can show.
      const content = el.closest('[data-sidebar="content"]')!;
      sessionStorage.setItem("adsbook:sidebar-place", JSON.stringify({ href: "/admin/settings/plugins", y: 640, scroll: Math.round(content.scrollTop) }));
    });
    await page.setViewportSize({ width: 1366, height: 560 });
    await page.goto(`${origin(store.slug)}/admin/settings/plugins`);
    await page.waitForLoadState("networkidle");
    const placed = await page.evaluate(() => {
      const content = document.querySelector('[data-sidebar="content"]')!;
      const item = content.querySelector('a[href="/admin/settings/plugins"]')!.getBoundingClientRect();
      const box = content.getBoundingClientRect();
      const footer = document.querySelector('[data-sidebar="footer"]')!.getBoundingClientRect();
      return { top: item.top - box.top, bottom: item.bottom, boxTop: box.top, footerTop: footer.top };
    });
    expect(placed.top, "inside the menu").toBeGreaterThanOrEqual(0);
    expect(placed.bottom, "clear of the footer card on the shorter window").toBeLessThanOrEqual(placed.footerTop);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls, "shorter-window restore cumulative layout shift").toBeLessThanOrEqual(0.005);
    if (process.env.PLUGINS_SHOT_DIR) await page.screenshot({ path: `${process.env.PLUGINS_SHOT_DIR}/sidebar-plugin-shorter-1366x560.png` });
    await page.setViewportSize({ width: 1366, height: 720 });
  }

  // Direct navigation (bookmark / address bar) to a bottom submenu item: not hidden behind the floating footer card.
  await page.goto(`${origin(store.slug)}/admin/settings/access`);
  await page.waitForLoadState("networkidle");
  const clearOfFooter = await page.evaluate(() => {
    const active = document.querySelector('[data-sidebar="content"] [aria-current="page"]')!;
    const footer = document.querySelector('[data-sidebar="footer"]')!;
    return active.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top;
  });
  expect(clearOfFooter, "direct load keeps Akses Pengguna above the footer card").toBe(true);

  for (const path of [
    "/admin/settings/domains",
    "/admin/settings/plugins",
    "/admin/settings/developer",
    "/admin/profile",
    "/admin/landing-pages",
    "/admin/settings",
    "/admin/ads/utm",
    // Tracking chapter 11: the three-card overview and the TikTok page fill after a fetch.
    "/admin/ads",
    "/admin/ads/tiktok",
    "/admin/ads/google",
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
