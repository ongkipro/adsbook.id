// Default storefront "Pasar Rapi" (owner direction A, 2026-11-23) in a real
// browser: home, catalogue and PDP span the screen (2/3/4/5-column grid), the
// header with its search stays on top, cards are compact and line up, the PDP
// turns two-column from 1024px, and nothing scrolls sideways.
import { expect, test } from "@playwright/test";
import { origin, TENANTS } from "./tenants.ts";

const SLUG = TENANTS[0].slug;
const STORE = origin(SLUG);

for (const [width, height, columns] of [
  [1440, 900, 5],
  [1024, 768, 4],
  [768, 1024, 3],
  [390, 844, 2],
  [360, 740, 2],
] as const) {
  test(`home at ${width}: sticky header with search, ${columns}-column grid, cards aligned, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${STORE}/`);
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
    await expect(page.getByRole("searchbox", { name: /Cari produk di/ })).toBeVisible();
    await expect(page.getByText("Official Store")).toHaveCount(0);

    const cards = page.locator("#product-grid .sf-card");
    await expect(cards.first()).toBeVisible();
    const boxes = await cards.evaluateAll((elements) => elements.slice(0, 10).map((element) => element.getBoundingClientRect().toJSON()));
    const firstRowTop = boxes[0].y;
    const firstRow = boxes.filter((box) => Math.abs(box.y - firstRowTop) < 1);
    expect(firstRow.length).toBe(Math.min(columns, boxes.length));
    // One row, one height: compact cards line up whatever their data.
    expect(new Set(firstRow.map((box) => Math.round(box.height))).size).toBe(1);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(width);

    await page.mouse.wheel(0, 900);
    await expect(header).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/storefront-home-${width}.png`, fullPage: true });
  });
}

test("the header search filters the catalogue on /produk, and the grid keeps the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${STORE}/`);
  const firstName = (await page.locator("#product-grid .sf-card h2").first().textContent())!.trim();
  await page.getByRole("searchbox", { name: /Cari produk di/ }).fill(firstName);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/produk\?q=/);
  await expect(page.getByRole("heading", { level: 1, name: "Semua produk" })).toBeVisible();
  await expect(page.locator("#product-grid .sf-card:visible").first()).toContainText(firstName);
  await expect(page.locator("#product-grid .product-card:not(.hidden)").filter({ hasNotText: firstName })).toHaveCount(0);
  await page.screenshot({ path: "test-results/storefront-catalog-1280.png" });
});

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`PDP at ${width}: ${width >= 1024 ? "two columns" : "one column"}, offer and order form intact`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${STORE}/`);
    const href = await page.locator("#product-grid a[href^='/produk/']").first().getAttribute("href");
    await page.goto(`${STORE}${href}`);
    const gallery = page.locator("[data-gallery]");
    const title = page.locator("main h1");
    await expect(title).toBeVisible();
    await expect(page.locator("#form-pemesanan")).toBeAttached();
    const galleryBox = (await gallery.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    if (width >= 1024) {
      expect(titleBox.x).toBeGreaterThan(galleryBox.x + galleryBox.width);
      await expect(page.getByRole("link", { name: "Beli sekarang" }).first()).toBeVisible();
      await expect(page.locator("#sticky-purchase-bar")).toBeHidden();
    } else {
      expect(titleBox.y).toBeGreaterThan(galleryBox.y + galleryBox.height - 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/storefront-pdp-${width}.png`, fullPage: true });
  });
}
