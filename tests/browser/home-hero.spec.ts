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
  expect(requests.some((url) => /kinetic-stage/.test(url)), "the home loads the stage chunk").toBe(true);
  // AUTH-LOGIN-REGISTER-UX-SPEC §2.1: the account button opens the sign-in page, never a modal.
  await expect(page.locator("#auth-dialog")).toHaveCount(0);
  await page.locator("#btn-user-auth").click();
  await expect(page).toHaveURL(`${PLATFORM}/masuk`);
  await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Masuk ke Toko");
  await page.goto(`${PLATFORM}/fitur`);
  problems.length = 0;
  requests.length = 0;
  await page.reload();
  await expect(page.locator("header")).toHaveCount(1);
  await expect(page.locator("header.site-header")).toHaveCount(1);
  expect(requests.filter((url) => /kinetic|KineticHero/.test(url)), "an inner page loads none of it").toEqual([]);
  expect(problems).toEqual([]);
});

const shotDir = process.env.HDR2_SHOT_DIR;
const htmlOverflow = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.style.overflow);

/** Paduka, 2026-11-18: on a phone the header ends [account] [menu], and the menu morphs into ×. */
async function phoneMenu(page: import("@playwright/test").Page, path: string, current: string | null, shotName?: string) {
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

  // Paduka (2026-11-18): the header and its × are never under the scrim, and the page behind
  // the menu does not scroll.
  await page.waitForTimeout(250); // the open transition
  const layering = await page.evaluate(() => {
    const hit = (selector: string) => {
      const target = document.querySelector(selector)!;
      const rect = target.getBoundingClientRect();
      const found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(found && (found === target || target.contains(found)));
    };
    const header = document.querySelector("header.site-header")!.getBoundingClientRect();
    const scrim = document.getElementById("mobile-nav-backdrop")!.getBoundingClientRect();
    return { closeButton: hit("#btn-mobile-menu"), wordmark: hit(".sh-wordmark"), scrimTop: scrim.top, headerBottom: header.bottom };
  });
  expect(layering.closeButton, "the × is on top, not under the scrim").toBe(true);
  expect(layering.wordmark, "the wordmark is not under the scrim").toBe(true);
  expect(layering.scrimTop, "the scrim starts under the header").toBeGreaterThanOrEqual(layering.headerBottom - 1);
  expect(await htmlOverflow(page)).toBe("hidden");
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(195, 820);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY), "the page behind the menu does not scroll").toBe(scrollBefore);
  if (shotDir && shotName) await page.screenshot({ path: `${shotDir}/${shotName}` });

  // The × itself closes the menu and gives the page its scroll back.
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  expect(await htmlOverflow(page)).toBe("");
  await button.click();

  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  expect(await htmlOverflow(page), "Escape unlocks the page").toBe("");

  await button.click();
  expect(await htmlOverflow(page)).toBe("hidden");
  await page.mouse.click(195, 820); // the backdrop, below the panel
  await expect(button).toHaveAttribute("aria-expanded", "false");
  expect(await htmlOverflow(page), "the backdrop unlocks the page").toBe("");

  // "Sudah punya toko?" is the sign-in page; leaving through it releases the scroll lock.
  await button.click();
  await panel.locator('a.sh-secondary[href="/masuk"]').click();
  await expect(page).toHaveURL(`${PLATFORM}/masuk`);
  expect(await htmlOverflow(page)).toBe("");
}

test("phone header on the home: [account] [menu ⇄ ×], a screen-aligned menu, sign-in from it", async ({ page }) => {
  await phoneMenu(page, "/", null, "hdr2-home-open-390.png");
  if (shotDir) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${PLATFORM}/`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${shotDir}/hdr2-home-1440.png` });
  }
});

test("the inner pages carry the same header: /fitur at 390, and the desktop nav at 1280", async ({ page }) => {
  await phoneMenu(page, "/fitur", "/fitur", "hdr2-fitur-open-390.png");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${PLATFORM}/fitur`);
  await expect(page.locator("#btn-mobile-menu")).toBeHidden();
  await expect(page.locator(".sh-nav a[aria-current=page]")).toHaveText("Fitur");
  await expect(page.locator("header .sh-try"), "the inner pages carry the home's clean header").toHaveCount(0);
  await page.goto(`${PLATFORM}/daftar`);
  await expect(page.locator("#btn-user-auth"), "the signup page keeps only the wordmark").toHaveCount(0);
});

test("a short phone screen: the menu scrolls inside itself, never past the screen, and the page stays locked", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto(`${PLATFORM}/fitur`);
  await page.locator("#btn-mobile-menu").click();
  const panel = page.locator("#mobile-nav-dropdown");
  await expect(panel).toBeVisible();
  await page.waitForTimeout(250);
  const fit = await panel.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, scrolls: el.scrollHeight > el.clientHeight }));
  expect(fit.bottom, "the panel ends on screen").toBeLessThanOrEqual(480);
  expect(fit.scrolls, "the rest of the menu is reachable by scrolling the panel").toBe(true);
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(panel.locator("a.sh-secondary")).toBeInViewport();
  expect(await page.evaluate(() => [document.documentElement.style.overflow, window.scrollY])).toEqual(["hidden", 0]);
  // Reopened, the panel starts at its first row again, never with the focused link above its top.
  await page.locator("#btn-mobile-menu").click();
  await expect(panel).toBeHidden();
  await page.locator("#btn-mobile-menu").click();
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(panel.locator("li a").first()).toBeInViewport();
});
