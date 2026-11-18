import { expect, test } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

/**
 * The home's 100dvh 3D hero (Paduka, 2026-11-18): real links, a working
 * Daftar / Masuk dialog, no console or CSP error, and the stage chunk
 * loaded on the home alone. The stage itself needs WebGL; without it the
 * hero must still settle (`is-still`), so a GPU-less runner proves the rest.
 */
test("home hero: real links, the account dialog, the stage on the home only", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${PLATFORM}/`);
  const hero = page.locator("#hero-root");
  await expect(hero).toHaveClass(/is-live|is-still/, { timeout: 15_000 });
  await expect(page.locator("h1")).toHaveCount(1);
  // One header on every page: the hero renders the shared SiteHeader, never a second one above it.
  await expect(page.locator("header")).toHaveCount(1);
  await expect(page.locator("#hero-root header.site-header")).toHaveCount(1);
  await expect(page.locator("#copy-inner a.cta-modern")).toHaveAttribute("href", "/daftar");
  await expect(page.locator("#btn-user-auth")).toHaveAttribute("href", "/masuk");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  if ((await hero.getAttribute("class"))?.includes("is-live")) {
    await page.locator("#token-meta").click();
    await expect(page.locator("#telemetry-status")).toHaveText(/^1:1 #MT-\d+$/);
    await expect(page.locator("#token-meta")).toHaveAttribute("aria-pressed", "true");
  }

  expect(problems, "the home itself: no console, CSP or page error").toEqual([]);
  await page.locator("#btn-user-auth").click();
  await expect(page.locator("#auth-dialog")).toBeVisible();
  await expect(page.locator("#auth-title")).toHaveText("Masuk ke toko Anda");
  await page.locator("#hero-store").fill("toko hero uji");
  const hello = page.waitForRequest((request) => request.url().startsWith("http://toko-hero-uji.localhost:") && request.url().endsWith("/hello"));
  await page.locator("#panel-masuk button[type=submit]").click();
  await hello;

  expect(requests.some((url) => /kinetic-stage/.test(url)), "the home loads the stage chunk").toBe(true);
  // The finder lands on that store's own host (no such test store: its 404 is not the home's).
  await page.goto(`${PLATFORM}/fitur`);
  problems.length = 0;
  requests.length = 0;
  await page.reload();
  await expect(page.locator("header")).toHaveCount(1);
  await expect(page.locator("header.site-header")).toHaveCount(1);
  expect(requests.filter((url) => /kinetic|KineticHero/.test(url)), "an inner page loads none of it").toEqual([]);
  expect(problems).toEqual([]);
});

/** Paduka, 2026-11-18: on a phone the header ends [account] [menu], and the menu morphs into ×. */
async function phoneMenu(page: import("@playwright/test").Page, path: string, current: string | null) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${PLATFORM}${path}`);
  const order = await page.locator("header .sh-tools > :visible").evaluateAll((els) => els.map((el) => el.id));
  expect(order).toEqual(["btn-user-auth", "btn-mobile-menu"]);
  await expect(page.locator(".sh-nav")).toBeHidden();

  const button = page.locator("#btn-mobile-menu");
  const panel = page.locator("#mobile-nav-dropdown");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toHaveAttribute("aria-label", "Tutup menu navigasi");
  await expect(panel).toBeVisible();
  await expect(panel.locator("li a")).toHaveCount(5);
  await expect(panel.locator(".row-hint").first()).not.toBeEmpty();
  if (current) await expect(panel.locator(`li a[href="${current}"]`)).toHaveAttribute("aria-current", "page");
  // Aligned to the screen: 1rem from each edge, below the header.
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.x)).toBe(16);
  expect(Math.round(390 - box.x - box.width)).toBe(16);
  const headerBottom = (await page.locator("header.site-header").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(headerBottom.y + headerBottom.height);

  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await page.mouse.click(195, 820); // the backdrop, below the panel
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // "Sudah punya toko?" opens the same dialog on Masuk, and closes the menu.
  await button.click();
  await panel.locator("[data-auth-open]").click();
  await expect(page.locator("#auth-dialog")).toBeVisible();
  await expect(page.locator("#auth-title")).toHaveText("Masuk ke toko Anda");
  await expect(button).toHaveAttribute("aria-expanded", "false");
}

test("phone header on the home: [account] [menu ⇄ ×], a screen-aligned menu, the dialog from it", async ({ page }) => {
  await phoneMenu(page, "/", null);
});

test("the inner pages carry the same header: /fitur at 390, and the desktop nav at 1280", async ({ page }) => {
  await phoneMenu(page, "/fitur", "/fitur");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${PLATFORM}/fitur`);
  await expect(page.locator("#btn-mobile-menu")).toBeHidden();
  await expect(page.locator(".sh-nav a[aria-current=page]")).toHaveText("Fitur");
  await expect(page.locator("header .sh-try"), "the inner pages carry the home's clean header").toHaveCount(0);
  await page.goto(`${PLATFORM}/daftar`);
  await expect(page.locator("#btn-user-auth"), "the signup page keeps only the wordmark").toHaveCount(0);
});
