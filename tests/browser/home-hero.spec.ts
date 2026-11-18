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
  await expect(page.locator("header.site-header")).toHaveCount(0);
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
  await expect(page.locator("header.site-header")).toHaveCount(1);
  expect(requests.filter((url) => /kinetic|KineticHero/.test(url)), "an inner page loads none of it").toEqual([]);
  expect(problems).toEqual([]);
});
