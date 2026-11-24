// Seller Plugin navigation (plan /tmp/adsbook-plugins-navigation-plan.md §3.1, §5), local fixtures only:
// Plugin is its own workspace right before Pengaturan for owner and admin, lit on the list and on a
// plugin's own page (Kelola), reachable by keyboard, in the icon rail and in the phone's menu sheet;
// management stays owner-only; Operator CS and Operator Ads never see it, and CS keeps Cek WA & Ongkir.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, PLATFORM, TENANTS } from "./tenants.ts";

const store = origin(TENANTS[0].slug);
const SHOTS = process.env.PLUGINS_SHOT_DIR ?? "test-results";
const PLUGINS = "/admin/settings/plugins";

const hydrated = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

async function signInAtMasuk(page: Page, identifier: string, password: string) {
  await page.goto(`${PLATFORM}/masuk`);
  await page.getByLabel("Email atau username").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk ke Dashboard →" }).click();
}

const json = (page: Page, path: string, method = "GET", body?: unknown) =>
  page.evaluate(async ([path, method, body]) => {
    const response = await fetch(path as string, { method: method as string, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  }, [path, method, body] as const);

/** A staff member as a fixture: created by the owner, temporary password replaced, signed in. */
async function staffPage(ownerPage: Page, page: Page, role: "admin" | "customer_service" | "advertiser") {
  const username = `${role.replace("_", "")}_plugin`;
  const created = await json(ownerPage, "/api/admin/access", "POST", { username, display_name: `Fixture ${role}`, role, password: "sementara-plugin-1" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  await signInAtMasuk(page, username, "sementara-plugin-1");
  await page.waitForURL(`${store}/admin/profile`, { timeout: 30_000 });
  const changed = await json(page, "/api/admin/profile", "PUT", { username, current_password: "sementara-plugin-1", new_password: "fixture-plugin-123", confirm_password: "fixture-plugin-123" });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  await signInAtMasuk(page, username, "fixture-plugin-123");
  await page.waitForURL(`${store}/admin/dashboard`, { timeout: 30_000 });
  return page;
}

/** The sidebar's top-level workspace links, in order. */
const workspaceLinks = (page: Page) =>
  page.locator('[data-sidebar="content"] [data-sidebar="menu-button"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")));

test("owner: Plugin is its own workspace right before Pengaturan, lit on the list and on Kelola; keyboard, icon rail and phone sheet", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  await signInAtMasuk(page, owner(TENANTS[0].slug).username, owner(TENANTS[0].slug).password);
  await page.waitForURL(`${store}/admin/dashboard`, { timeout: 30_000 });

  // Order: Pembayaran, Tema, Plugin, Pengaturan (Tema since 2026-11-23).
  const links = await workspaceLinks(page);
  expect(links.indexOf(PLUGINS), `order: ${links.join(" ")}`).toBe(links.indexOf("/admin/settings") - 1);
  expect(links[links.indexOf(PLUGINS) - 1]).toBe("/admin/settings/theme");
  expect(links[links.indexOf(PLUGINS) - 2]).toBe("/admin/payments");
  expect(await page.locator(`[data-sidebar="content"] a[href="${PLUGINS}"]`).count(), "one Plugin link, not also a Pengaturan child").toBe(1);

  // The list page lights Plugin, not Pengaturan; Pengaturan's sub-list stays closed.
  await page.goto(`${store}${PLUGINS}`);
  await hydrated(page);
  const plugin = page.locator(`[data-sidebar="content"] a[href="${PLUGINS}"]`);
  await expect(plugin).toHaveAttribute("aria-current", "page");
  await expect(plugin).toHaveAttribute("data-active", "");
  await expect(page.locator('[data-sidebar="content"] a[href="/admin/settings"]')).not.toHaveAttribute("data-active");
  await expect(page.locator('[data-sidebar="content"] a[href="/admin/settings/domains"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Plugin" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/plugins-owner-list-1366.png` });

  // Kelola, a plugin's own page: activate it as the owner, open it, Plugin stays lit.
  const activated = page.waitForResponse((response) => response.url().endsWith("/api/admin/plugins") && response.request().method() === "POST");
  await page.getByRole("button", { name: /Pasang & aktifkan|Aktifkan lagi/ }).first().click();
  expect((await activated).status(), "the owner activates Kelola").toBe(200);
  // The plugin card's own "Pengaturan" link (not the sidebar's Pengaturan workspace).
  await Promise.all([page.waitForURL(`${store}${PLUGINS}/kelola`), page.locator(`main a[href="${PLUGINS}/kelola"]`).click()]);
  await hydrated(page);
  await expect(plugin).toHaveAttribute("aria-current", "page");
  await expect(plugin).toHaveAttribute("data-active", "");
  await expect(page.locator('[data-sidebar="content"] a[href="/admin/settings"]')).not.toHaveAttribute("data-active");
  await page.screenshot({ path: `${SHOTS}/plugins-owner-kelola-1366.png` });

  // Keyboard: from Tema (between Pembayaran and Plugin since 2026-11-23), Tab reaches Plugin, then Pengaturan; the focus is visible; Enter opens Plugin.
  await page.goto(`${store}/admin/dashboard`);
  await hydrated(page);
  await page.locator('[data-sidebar="content"] a[href="/admin/settings/theme"]').focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe(PLUGINS);
  const focusVisible = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return style.outlineStyle !== "none" || (style.boxShadow !== "none" && style.boxShadow !== "");
  });
  expect(focusVisible, "the focused Plugin link shows a focus indicator").toBe(true);
  await page.screenshot({ path: `${SHOTS}/plugins-owner-focus-1366.png` });
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/admin/settings");
  await page.keyboard.press("Shift+Tab");
  await Promise.all([page.waitForURL(`${store}${PLUGINS}`), page.keyboard.press("Enter")]);

  // The seller restore's padded path (Pengaturan page → Plugin on a 720px window), then the icon rail keeps its own padding.
  await page.setViewportSize({ width: 1366, height: 720 });
  await page.goto(`${store}/admin/settings/domains`);
  await hydrated(page);
  const fromSettings = page.locator(`[data-sidebar="content"] a[href="${PLUGINS}"]`);
  await fromSettings.scrollIntoViewIfNeeded();
  await Promise.all([page.waitForURL(`${store}${PLUGINS}`), fromSettings.click()]);
  await hydrated(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-restore-pad").trim()), "the padded path ran").toMatch(/^[1-9]\d*px$/);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator('[data-sidebar="content"]')).toHaveCSS("padding-bottom", "112px");

  // Icon rail (tablet width): the Plugin icon is there and names itself on hover.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${store}${PLUGINS}`);
  await hydrated(page);
  const railPlugin = page.locator(`[data-sidebar="content"] a[href="${PLUGINS}"]`);
  await expect(railPlugin).toBeVisible();
  await railPlugin.hover();
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Plugin" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/plugins-owner-rail-900.png` });

  // Phone: the menu sheet lists Plugin as its own row, current, in view; closing returns focus to the trigger.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${store}${PLUGINS}/kelola`);
  await hydrated(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "no horizontal overflow").toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Buka semua menu" }).click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  const row = sheet.locator(`a[href="${PLUGINS}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(row).toBeInViewport();
  await expect(sheet.locator('a[href="/admin/settings"][aria-current="page"]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/plugins-owner-sheet-390.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator("#admin-mobile-menu-trigger")).toBeFocused();

  expect(errors, "console errors").toEqual([]);
  await context.close();
});

test("admin sees Plugin but cannot manage; Operator CS and Operator Ads never see it and keep their own menus", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ownerPage = await ownerContext.newPage();
  await signInAtMasuk(ownerPage, owner(TENANTS[0].slug).username, owner(TENANTS[0].slug).password);
  await ownerPage.waitForURL(`${store}/admin/dashboard`, { timeout: 30_000 });

  // Admin: the link, the page, read-only.
  const adminContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const admin = await staffPage(ownerPage, await adminContext.newPage(), "admin");
  const adminLinks = await workspaceLinks(admin);
  expect(adminLinks.indexOf(PLUGINS)).toBe(adminLinks.indexOf("/admin/settings") - 1);
  await admin.goto(`${store}${PLUGINS}`);
  await hydrated(admin);
  await expect(admin.locator(`[data-sidebar="content"] a[href="${PLUGINS}"]`)).toHaveAttribute("aria-current", "page");
  for (const button of await admin.getByRole("button", { name: /Pasang & aktifkan|Aktifkan lagi|Nonaktifkan|Hapus data/ }).all()) await expect(button).toBeDisabled();
  expect((await json(admin, "/api/admin/plugins", "POST", { id: "kelola", action: "activate" })).status, "management stays owner-only").toBe(403);
  await admin.screenshot({ path: `${SHOTS}/plugins-admin-list-1366.png` });
  await adminContext.close();

  // Operator CS: no Plugin anywhere; Cek WA & Ongkir in the sidebar and the phone's bottom bar.
  const csContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const cs = await staffPage(ownerPage, await csContext.newPage(), "customer_service");
  expect(await workspaceLinks(cs)).toEqual(["/admin/dashboard", "/admin/orders", "/admin/shipping", "/admin/check"]);
  await cs.goto(`${store}${PLUGINS}`);
  await expect(cs, "the page is refused").toHaveURL(`${store}/admin/dashboard`);
  expect((await json(cs, "/api/admin/plugins")).status).toBe(403);
  await cs.setViewportSize({ width: 390, height: 844 });
  await cs.goto(`${store}/admin/check`);
  await hydrated(cs);
  const bottom = cs.getByRole("navigation", { name: "Navigasi utama mobile" });
  const check = bottom.locator('a[href="/admin/check"]');
  await expect(check).toHaveAttribute("aria-current", "page");
  // Legibility of the existing label, observed only (the optional shortLabel is out of scope).
  const label = await check.locator("span").last().evaluate((el) => ({ text: el.textContent, truncated: el.scrollWidth > el.clientWidth }));
  test.info().annotations.push({ type: "cs-bottom-label", description: JSON.stringify(label) });
  await cs.screenshot({ path: `${SHOTS}/plugins-cs-check-390.png` });
  await cs.getByRole("button", { name: "Buka semua menu" }).click();
  await expect(cs.locator(`[data-slot="sheet-content"] a[href="${PLUGINS}"]`)).toHaveCount(0);
  await csContext.close();

  // Operator Ads: no Plugin either.
  const adsContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ads = await staffPage(ownerPage, await adsContext.newPage(), "advertiser");
  expect(await workspaceLinks(ads)).not.toContain(PLUGINS);
  await ads.goto(`${store}${PLUGINS}`);
  await expect(ads).toHaveURL(`${store}/admin/dashboard`);
  await adsContext.close();
  await ownerContext.close();
});
