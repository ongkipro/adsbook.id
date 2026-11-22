// /hello "Whiteprint" (owner direction B, 2026-11-23) in a real browser: the
// blueprint is the left column on a desktop and a fixed background behind a
// centred card below 1024px; one screen, no scroll; the wordmark loops;
// reduced motion stills both.
import { expect, test } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const SLUG = TENANTS[0].slug;

for (const [width, height, layout] of [
  [1440, 900, "desktop"],
  [1024, 768, "desktop"],
  [820, 1180, "background"],
  [390, 844, "background"],
  [360, 640, "background"],
] as const) {
  test(`/hello at ${width}x${height}: ${layout} blueprint, centred card, no scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin(SLUG)}/hello`);
    const card = page.locator(".admin-login-card");
    const sheet = page.locator(".login-blueprint");
    await expect(card).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(page.locator(".login-blueprint-svg")).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".login-subtitle")).toContainText(TENANTS[0].name);

    const scroll = await page.evaluate(() => ({ x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight }));
    expect(scroll.x).toBeLessThanOrEqual(width);
    expect(scroll.y).toBeLessThanOrEqual(height);

    const box = (await card.boundingBox())!;
    const sheetBox = (await sheet.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    if (layout === "desktop") {
      expect(sheetBox.x).toBe(0);
      expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(box.x);
      await expect(page.locator(".login-blueprint-caption")).toBeVisible();
    } else {
      expect(sheetBox.width).toBe(width);
      expect(sheetBox.height).toBe(height);
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      await expect(page.locator(".login-blueprint-caption")).toBeHidden();
    }
    // Wait for the sheet to finish drawing before the evidence shot.
    await page.waitForTimeout(3200);
    await page.screenshot({ path: `test-results/hello-blueprint-${width}.png` });
  });
}

test("/hello: the wordmark replays the drawing on a loop, the password toggle keeps its names, sign-in still works", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin(SLUG)}/hello`);
  const wordmark = page.locator("#loginWordmark");
  await expect(wordmark).toHaveAttribute("src", /wordmark-animated\.svg#r1$/);
  await expect(wordmark).toHaveAttribute("src", /#r2$/, { timeout: 8_000 });
  await expect(page.getByRole("link", { name: `adsbook.id, kembali ke beranda ${TENANTS[0].name}` })).toBeVisible();

  const toggle = page.getByRole("button", { name: "Tampilkan password" });
  await page.getByLabel("Password", { exact: true }).fill("rahasia");
  await toggle.click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Sembunyikan password" })).toHaveAttribute("aria-pressed", "true");

  const { username, password } = owner(SLUG);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
});

test("/hello under reduced motion: the still wordmark and a drawn, motionless sheet", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin(SLUG)}/hello`);
  await page.waitForTimeout(1200);
  await expect(page.locator("#loginWordmark")).toHaveAttribute("src", /adsbook-wordmark\.svg$/);
  const node = page.locator(".bp-node").first();
  expect(await node.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  expect(await node.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  expect(await page.locator(".bp-packets").evaluate((element) => getComputedStyle(element).display)).toBe("none");
  await context.close();
});
