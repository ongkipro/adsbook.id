// The storefront is the 480px column on every screen (owner, 2026-11-23: an ad
// tapped on a phone lands on a COD form). In a real browser: the column never
// exceeds 480px, the header with its search stays on top, cards are compact
// and line up two to a row, the PDP is one column with the sticky buy bar,
// and nothing scrolls sideways.
import { expect, test } from "@playwright/test";
import { origin, TENANTS } from "./tenants.ts";

const STORE = origin(TENANTS[0].slug);

for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [360, 740]] as const) {
  test(`home at ${width}: one 480px column, sticky search header, two aligned cards a row`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${STORE}/`);
    const main = page.locator("#main-content");
    const box = (await main.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(480);
    if (width > 480) expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("searchbox", { name: /Cari produk di/ })).toBeVisible();
    await expect(page.getByText("Official Store")).toHaveCount(0);

    const cards = await page.locator("#product-grid .sf-card").evaluateAll((elements) => elements.slice(0, 4).map((element) => element.getBoundingClientRect().toJSON()));
    expect(Math.round(cards[0].y)).toBe(Math.round(cards[1].y));
    expect(cards[2].y).toBeGreaterThan(cards[0].y);
    expect(Math.round(cards[0].height)).toBe(Math.round(cards[1].height));

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.mouse.wheel(0, 900);
    await expect(page.locator("header").first()).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/storefront-compact-home-${width}.png`, fullPage: true });
  });
}

test("the header search filters the catalogue on /produk", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${STORE}/`);
  const firstName = (await page.locator("#product-grid .sf-card h2").first().textContent())!.trim();
  await page.getByRole("searchbox", { name: /Cari produk di/ }).fill(firstName);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/produk\?q=/);
  await expect(page.getByRole("heading", { level: 1, name: "Semua produk" })).toBeVisible();
  await expect(page.locator("#product-grid .product-card:not(.hidden)").filter({ hasNotText: firstName })).toHaveCount(0);
});

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`PDP at ${width}: one column, photo first, the sticky buy bar once past the photo`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${STORE}/`);
    const href = await page.locator("#product-grid a[href^='/produk/']").first().getAttribute("href");
    await page.goto(`${STORE}${href}`);
    const gallery = (await page.locator("[data-gallery]").boundingBox())!;
    const title = (await page.locator("main h1").boundingBox())!;
    expect(title.y).toBeGreaterThan(gallery.y + gallery.height - 1);
    expect(gallery.width).toBeLessThanOrEqual(480);
    await page.screenshot({ path: `test-results/storefront-compact-pdp-${width}.png`, fullPage: true });
    // Between the photo and the order form: the bar's moment (it hides over both).
    // A short viewport so that gap holds a whole screen whatever the offer's height.
    const gap = await page.evaluate(() => {
      const photo = document.querySelector("[data-gallery]")!.getBoundingClientRect().bottom + window.scrollY;
      const form = document.getElementById("form-pemesanan")!.getBoundingClientRect().top + window.scrollY;
      return { photo, form };
    });
    const viewport = Math.max(160, Math.floor(gap.form - gap.photo - 48));
    await page.setViewportSize({ width, height: viewport });
    await page.evaluate((top) => window.scrollTo(0, top + 8), gap.photo);
    expect(await page.locator("#form-pemesanan").evaluate((form) => form.getBoundingClientRect().top > window.innerHeight)).toBe(true);
    const bar = page.locator("#sticky-purchase-bar");
    await expect(bar).toHaveCSS("opacity", "1");
    expect((await bar.boundingBox())!.width).toBeLessThanOrEqual(480);
    await expect(bar.getByRole("link", { name: "Beli sekarang" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
