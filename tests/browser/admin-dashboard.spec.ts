// Admin dashboard SSR, single-fetch rankings, URL filter persistence, CLS,
// and responsive layout checks across desktop (1366) and phone (390).
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const STORE = origin("toko-alfa");

async function signIn(page: Page) {
  const { username, password } = owner("toko-alfa");
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

test("dashboard SSR renders KPIs with low CLS, single-fetch rankings, and URL-persistent filters", async ({ browser }) => {
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  await desktop.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  const page = await desktop.newPage();
  const errors: string[] = [];
  const apiHits: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/admin/analytics") || url.includes("/api/admin/insights")) {
      apiHits.push(url);
    }
  });

  await signIn(page);

  // Verify raw SSR HTML already ships KPI cards without waiting for client fetch.
  const response = await page.goto(`${STORE}/admin/dashboard`);
  expect(response?.status()).toBe(200);
  const ssrHtml = await response!.text();
  expect(ssrHtml).toContain("Revenue");
  expect(ssrHtml).toContain("Sales funnel");
  expect(ssrHtml).toContain("WIB");
  expect(ssrHtml).toContain("56.832");

  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);

  // Initial load hydrates from SSR props without firing redundant analytics/insights fetches.
  expect(apiHits, "SSR dashboard does not refetch analytics or insights on first load").toEqual([]);

  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls, "dashboard cumulative layout shift").toBeLessThanOrEqual(0.01);

  // Funnel steps are deep links to their operational queues.
  await expect(page.getByRole("link", { name: /Leads/ })).toHaveAttribute("href", /\/admin\/orders\/abandoned/);
  await expect(page.getByRole("link", { name: /Orders/ })).toHaveAttribute("href", /\/admin\/orders\?/);
  await expect(page.getByRole("link", { name: /Shipped/ })).toHaveAttribute("href", /\/admin\/shipping/);

  // Zero horizontal overflow on desktop.
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(desktopOverflow, "no horizontal overflow at 1366px").toBeLessThanOrEqual(0);

  if (process.env.DASHBOARD_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.DASHBOARD_SHOT_DIR}/admin-dashboard-1366.png`, fullPage: true });
    await page.getByRole("heading", { name: "Sales funnel" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${process.env.DASHBOARD_SHOT_DIR}/admin-dashboard-1366-lower.png`, fullPage: true });
  }

  // Switching preset & compare updates URL query and uses the single combined endpoint.
  await page.locator("section[aria-label='Date range dan pembanding'] button").first().click();
  await page.getByRole("button", { name: "Kemarin", exact: true }).click();
  await page.waitForFunction(() => new URL(window.location.href).searchParams.get("preset") === "yesterday");
  await page.waitForLoadState("networkidle");

  expect(apiHits.some((u) => u.includes("/api/admin/analytics") && u.includes("include=rankings"))).toBe(true);
  expect(apiHits.some((u) => u.includes("/api/admin/insights")), "no legacy split /api/admin/insights calls").toBe(false);

  // Reloading preserves the selected filter from the URL.
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.locator("section[aria-label='Date range dan pembanding'] button").first()).toContainText("Kemarin");

  expect(errors, "no console or page errors on desktop").toEqual([]);
  await desktop.close();

  // Phone viewport (390px): zero overflow, zero errors, readable layout.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobile.newPage();
  const mobileErrors: string[] = [];
  mPage.on("pageerror", (error) => mobileErrors.push(String(error)));
  mPage.on("console", (message) => {
    if (message.type() === "error") mobileErrors.push(message.text());
  });
  await signIn(mPage);
  await mPage.goto(`${STORE}/admin/dashboard`);
  await mPage.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await mPage.waitForLoadState("networkidle");
  await mPage.waitForTimeout(300);

  const mobileOverflow = await mPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(mobileOverflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(0);

  if (process.env.DASHBOARD_SHOT_DIR) {
    await mPage.screenshot({ path: `${process.env.DASHBOARD_SHOT_DIR}/admin-dashboard-390.png`, fullPage: true });
    await mPage.getByRole("heading", { name: "Sales funnel" }).scrollIntoViewIfNeeded();
    await mPage.waitForTimeout(150);
    await mPage.screenshot({ path: `${process.env.DASHBOARD_SHOT_DIR}/admin-dashboard-390-lower.png`, fullPage: true });
  }

  expect(mobileErrors, "no console or page errors on mobile").toEqual([]);
  await mobile.close();
});

test("section rails and header tabs render with SSR data, flat sidebar, and zero overflow across desktop and phone", async ({ browser }) => {
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await desktop.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await signIn(page);

  // Desktop sidebar is completely flat (zero expanding sub-menus).
  const checks = [
    { path: "/admin/analytics", rail: "analytics", ssrToken: "Periode terpilih", shot: "admin-analytics-1366.png" },
    { path: "/admin/ads", rail: "ads", ssrToken: 'data-ssr-ready="1"', shot: "admin-ads-1366.png" },
    { path: "/admin/payments", rail: "payments", ssrToken: "Konfigurasi checkout AutoLaris", shot: "admin-payments-1366.png" },
    { path: "/admin/balance", rail: "payments", ssrToken: "Verifikasi pembayaran AutoLaris", shot: "" },
    { path: "/admin/expeditions", rail: null, ssrToken: "Kebijakan COD per provinsi", shot: "admin-expeditions-1366.png" },
    { path: "/admin/orders", rail: null, ssrToken: "Pesanan tertinggal", shot: "" },
    { path: "/admin/products", rail: null, ssrToken: "Landing page", shot: "" },
  ];

  for (const item of checks) {
    const response = await page.goto(`${STORE}${item.path}`);
    expect(response?.status(), `${item.path} status`).toBe(200);
    const html = await response!.text();
    expect(html, `${item.path} SSR content`).toContain(item.ssrToken);
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    await page.waitForLoadState("networkidle");

    expect(await page.locator('[data-sidebar="menu-sub"]').count(), `${item.path}: desktop sidebar stays flat`).toBe(0);
    if (item.rail) {
      await expect(page.locator(`[data-section-rail="${item.rail}"]`)).toBeVisible();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${item.path} no overflow at 1366px`).toBeLessThanOrEqual(0);
    if (process.env.DASHBOARD_SHOT_DIR && item.shot) {
      await page.screenshot({ path: `${process.env.DASHBOARD_SHOT_DIR}/${item.shot}`, fullPage: true });
    }
  }

  expect(errors, "no console or page errors on desktop panels").toEqual([]);
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobile.newPage();
  const mobileErrors: string[] = [];
  mPage.on("pageerror", (error) => mobileErrors.push(String(error)));
  mPage.on("console", (message) => {
    if (message.type() === "error") mobileErrors.push(message.text());
  });
  await signIn(mPage);
  for (const path of ["/admin/analytics", "/admin/ads", "/admin/payments", "/admin/expeditions", "/admin/orders", "/admin/products"]) {
    await mPage.goto(`${STORE}${path}`);
    await mPage.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    await mPage.waitForLoadState("networkidle");
    const overflow = await mPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} no overflow at 390px`).toBeLessThanOrEqual(0);
    if (process.env.DASHBOARD_SHOT_DIR && (path === "/admin/payments" || path === "/admin/expeditions")) {
      const slug = path.split("/").pop();
      await mPage.screenshot({ path: `${process.env.DASHBOARD_SHOT_DIR}/admin-${slug}-390.png`, fullPage: true });
    }
  }
  expect(mobileErrors, "no console or page errors on mobile panels").toEqual([]);
  await mobile.close();
});
