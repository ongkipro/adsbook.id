// The storefront is the 480px column on every screen (owner, 2026-11-23: an ad
// tapped on a phone lands on a COD form). In a real browser: the column never
// exceeds 480px, the centred header says "Official Store", the hero is full
// width and slides by itself, cards line up two to a row, the PDP is one
// column with the sticky buy bar and no WhatsApp button, nothing scrolls sideways.
import { expect, test } from "@playwright/test";
import { origin, TENANTS } from "./tenants.ts";

const STORE = origin(TENANTS[0].slug);

for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [360, 740]] as const) {
  test(`home at ${width}: one 480px column, Official Store header, full-width hero, two aligned cards a row`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${STORE}/`);
    const main = page.locator("#main-content");
    const box = (await main.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(480);
    if (width > 480) expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    await expect(page.locator("header").getByText("Official Store", { exact: true })).toBeVisible();
    await expect(page.locator("header").getByRole("searchbox")).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: /Cari produk di/ })).toBeVisible();
    const hero = (await page.locator("[data-hero]").boundingBox())!;
    expect(Math.round(hero.width)).toBe(Math.round(box.width));
    expect(Math.round(hero.x)).toBe(Math.round(box.x));

    const cards = await page.locator("#product-grid .sf-card").evaluateAll((elements) => elements.slice(0, 4).map((element) => element.getBoundingClientRect().toJSON()));
    expect(Math.round(cards[0].y)).toBe(Math.round(cards[1].y));
    expect(cards[2].y).toBeGreaterThan(cards[0].y);
    expect(Math.round(cards[0].height)).toBe(Math.round(cards[1].height));

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await page.screenshot({ path: `test-results/storefront-compact-home-${width}.png`, fullPage: true });
  });
}

test("the catalogue search filters the grid as you type, and a ?q= link arrives filtered", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${STORE}/`);
  const firstName = (await page.locator("#product-grid .sf-card h2").first().textContent())!.trim();
  await page.getByRole("searchbox", { name: /Cari produk di/ }).fill(firstName);
  await expect(page.locator("#product-grid .product-card:not(.hidden)").filter({ hasNotText: firstName })).toHaveCount(0);
  await page.goto(`${STORE}/produk?q=${encodeURIComponent(firstName)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Semua produk" })).toBeVisible();
  await expect(page.locator("#product-grid .product-card:not(.hidden)").filter({ hasNotText: firstName })).toHaveCount(0);
});

test("the hero: three to five products with a summary, sliding by itself; still under reduced motion", async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${STORE}/`);
  const slides = page.locator("[data-hero-slide]");
  const count = await slides.count();
  expect(count).toBeGreaterThanOrEqual(3);
  expect(count).toBeLessThanOrEqual(5);
  await expect(slides.first().locator('a[href^="/produk/"]')).toHaveCount(1);
  const dots = page.locator("#hero-dots button");
  await expect(dots.first()).toHaveAttribute("aria-current", "true");
  await expect(dots.nth(1)).toHaveAttribute("aria-current", "true", { timeout: 8_000 });

  const still = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const calm = await still.newPage();
  await calm.goto(`${STORE}/`);
  await calm.waitForTimeout(6_000);
  await expect(calm.locator("#hero-dots button").first()).toHaveAttribute("aria-current", "true");
  await still.close();
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
    // The order form is the one action: no WhatsApp link anywhere on the product page.
    expect(await page.locator('main a[href*="wa.me"], main a[href*="api.whatsapp.com"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("order form: grey 'Pesan Sekarang' until the contact is complete, lit after; a grey tap marks the fields; 12px floor; one spacing system; no order sent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posted: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /submit-.*order/.test(request.url())) posted.push(request.url()); });
  await page.goto(`${STORE}/`);
  const href = await page.locator("#product-grid a[href^='/produk/']").first().getAttribute("href");
  await page.goto(`${STORE}${href}`);
  const form = page.locator("#form-pemesanan");
  const submit = form.locator("#submit-button");
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toHaveText(/Pesan Sekarang/);
  await expect(submit).toHaveAttribute("data-state", "disabled");
  expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(48);

  // A tap while grey still reaches the handler: it marks what is missing, posts nothing.
  // `force`: Playwright waits out aria-disabled; a finger does not, and the button is not natively disabled.
  expect(await submit.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(false);
  await submit.click({ force: true });
  await expect(form.locator('[aria-invalid="true"]').first()).toBeVisible();
  await expect(form.getByText("Maaf, masih ada data yang perlu dilengkapi dengan benar.")).toBeVisible();
  await form.screenshot({ path: "test-results/storefront-form-errors-390.png" });

  // Complete: the same label, lit.
  await form.getByLabel(/Nama lengkap/).fill("Siti Pembeli");
  await form.getByLabel(/Nomor WhatsApp/).fill("081234567890");
  await form.getByLabel(/Alamat lengkap/).fill("Jl. Dago No. 12, Coblong, Bandung");
  await expect(submit).toHaveAttribute("data-state", "ready");
  await expect(submit).toHaveText(/Pesan Sekarang/);
  await expect(form.getByText("Maaf, masih ada data yang perlu dilengkapi dengan benar."), "the stale banner goes").toBeHidden();
  expect(posted, "no order is sent by this test").toEqual([]);

  const tiny = await form.evaluate((root) =>
    [...root.querySelectorAll("*")]
      .filter((element) => (element as HTMLElement).offsetParent && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim()))
      .filter((element) => parseFloat(getComputedStyle(element).fontSize) < 12)
      .map((element) => `${element.tagName} ${getComputedStyle(element).fontSize} "${element.textContent!.trim().slice(0, 20)}"`),
  );
  expect(tiny, "the checkout text keeps the 12px floor").toEqual([]);

  // One spacing system: every block edge on the same 16px inset, 28px between blocks.
  const geometry = await form.evaluate((root) => {
    const r0 = root.getBoundingClientRect();
    const blocks = [...root.querySelectorAll(".form-block")].filter((block) => (block as HTMLElement).offsetParent);
    const insets = [...root.querySelectorAll(".section-title, .field-grid input:not([tabindex='-1']), .simple-variant-copy, .summary-card, .submit-main")]
      .filter((element) => (element as HTMLElement).offsetParent)
      .map((element) => { const r = element.getBoundingClientRect(); return [Math.round(r.left - r0.left), Math.round(r0.right - r.right)]; });
    const gaps = blocks.slice(1).map((block, index) => Math.round(block.getBoundingClientRect().top - blocks[index].getBoundingClientRect().bottom));
    return { insets: [...new Set(insets.map((pair) => pair.join(",")))], gaps: [...new Set(gaps)] };
  });
  expect(geometry.insets, "one left/right inset for every row").toEqual(["16,16"]);
  expect(geometry.gaps, "one gap between blocks").toEqual([28]);
  await form.screenshot({ path: "test-results/storefront-form-ready-390.png" });
});

test("an empty search says so and offers to clear it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${STORE}/produk?q=zzzz-tidak-ada`);
  await expect(page.getByText("Produk tidak ditemukan", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/storefront-search-empty-390.png" });
  await page.getByRole("button", { name: "Hapus pencarian" }).click();
  await expect(page.locator("#product-grid .product-card:not(.hidden)").first()).toBeVisible();
  await expect(page.getByRole("searchbox", { name: /Cari produk di/ })).toHaveValue("");
  expect(new URL(page.url()).search).toBe("");
});

test("404 is the storefront's own page: one heading, a 48px way home, related products", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${STORE}/produk/tidak-ada-produk-ini`);
  await expect(page.getByRole("heading", { level: 1, name: "Halaman tidak ditemukan" })).toBeVisible();
  const home = page.getByRole("link", { name: "Kembali ke beranda" });
  expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await expect(page.getByRole("heading", { name: "Mungkin ini yang Anda cari" })).toBeVisible();
  await page.screenshot({ path: "test-results/storefront-404-390.png", fullPage: true });
});
