// Admin › Tema in a real browser: the menu item above Plugin, two cards
// (Compact active, the next 480px theme "Segera hadir"), "Atur beranda" on the
// active one, and every setting reaching the 480px storefront.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, TENANTS } from "./tenants.ts";

const SLUG = TENANTS[1].slug;
const STORE = origin(SLUG);

async function signIn(page: Page) {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

test("Tema: menu above Plugin, two cards, configure the homepage, all visible on the store", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);

  // The menu: Tema right above Plugin, among the sidebar's workspace links.
  const hrefs = await page.locator('[data-sidebar="content"] [data-sidebar="menu-button"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  const tema = hrefs.indexOf("/admin/settings/theme");
  expect(tema).toBeGreaterThanOrEqual(0);
  expect(hrefs[tema + 1]).toBe("/admin/settings/plugins");

  await page.locator('[data-sidebar="content"] a[href="/admin/settings/theme"]').click();
  await page.waitForURL(/\/admin\/settings\/theme$/);
  const compact = page.locator('[data-theme-card="compact-market"]');
  const soon = page.locator('[data-theme-card="soon"]');
  await expect(compact.getByText("Aktif", { exact: true })).toBeVisible();
  await expect(soon.getByText("Segera hadir", { exact: true })).toBeVisible();
  await expect(soon.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: "test-results/admin-theme-cards-1366.png" });

  // Atur beranda: the banner editor, then the section builder with its live preview.
  await compact.getByRole("link", { name: "Atur beranda" }).click();
  await page.waitForURL(/\/admin\/settings\/theme\/beranda$/);
  await expect(page.getByRole("heading", { level: 2, name: "Atur beranda" })).toBeVisible();
  await expect(page.getByLabel("Pilih gambar banner")).toBeAttached();
  const sections = page.locator("[data-home-section]");
  await expect(sections).toHaveCount(6);
  const save = page.getByRole("button", { name: "Simpan", exact: true });
  await expect(save).toBeDisabled();

  // Announcement on, with a link; trust strip off; catalogue renamed and sorted cheapest first.
  await page.getByRole("switch", { name: "Pengumuman" }).click();
  await page.locator('[data-home-section="announcement"] [data-section-toggle]').click();
  await page.getByPlaceholder("Gratis ongkir se-Jawa sampai Minggu").fill("Gratis ongkir minggu ini");
  await page.getByPlaceholder("/produk").fill("/produk");
  await page.getByRole("switch", { name: "Strip kepercayaan" }).click();
  await page.locator('[data-home-section="catalog"] [data-section-toggle]').click();
  await page.getByLabel("Judul katalog").fill("Koleksi minggu ini");
  await page.getByRole("combobox", { name: "Urutan produk" }).click();
  await page.getByRole("option", { name: "Harga terendah" }).click();
  // Featured: on, two products, moved above the hero.
  await page.getByRole("switch", { name: "Pilihan kami" }).click();
  await page.locator('[data-home-section="featured"] [data-section-toggle]').click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("combobox", { name: "Tambah produk" }).click();
    await page.getByRole("option").first().click();
  }
  await page.getByRole("button", { name: "Naikkan Pilihan kami" }).click();
  await page.getByRole("button", { name: "Naikkan Pilihan kami" }).click();
  await page.getByRole("switch", { name: "Cara pesan" }).click();
  await expect(page.getByText("Ada perubahan yang belum disimpan.")).toBeVisible();

  // The live preview shows the unsaved page; buyers do not see it yet.
  const preview = page.frameLocator('iframe[title="Pratinjau beranda toko"]');
  await expect(preview.getByRole("heading", { name: "Koleksi minggu ini" })).toBeVisible({ timeout: 15_000 });
  await expect(preview.getByText("Gratis ongkir minggu ini")).toBeVisible();
  const buyer = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await buyer.goto(`${STORE}/`);
  await expect(buyer.getByText("Gratis ongkir minggu ini")).toHaveCount(0);
  // Someone without a session asking for the preview gets the ordinary page.
  await buyer.goto(`${STORE}/?preview=home&s=${Buffer.from(JSON.stringify({ x: 1 })).toString("base64url")}`);
  await expect(buyer.getByText("Gratis ongkir minggu ini")).toHaveCount(0);

  // A too-light accent is refused with the reason, and nothing changes.
  await page.getByLabel("Kode warna").fill("#FACC15");
  await save.click();
  await expect(page.getByText(/terlalu terang untuk tombol/)).toBeVisible();
  await page.getByRole("radio", { name: "#0F766E" }).click();
  await save.click();
  await expect(page.getByText("Pengaturan beranda tersimpan dan langsung tampil di toko.")).toBeVisible();
  await expect(page.getByText("Semua perubahan tersimpan.")).toBeVisible();
  await page.screenshot({ path: "test-results/admin-theme-beranda-1366.png", fullPage: true });

  // The storefront, as a buyer: the announcement, featured above the hero, no trust strip,
  // the heading, cheapest first, the steps, the accent; always the 480px column.
  await buyer.goto(`${STORE}/?v=${Date.now()}`);
  await expect(buyer.getByRole("link", { name: /Gratis ongkir minggu ini/ })).toHaveAttribute("href", "/produk");
  await expect(buyer.getByRole("heading", { name: "Koleksi minggu ini" })).toBeVisible();
  await expect(buyer.getByRole("heading", { name: "Pilihan kami" })).toBeVisible();
  await expect(buyer.getByRole("heading", { name: "Cara pesan" })).toBeVisible();
  await expect(buyer.locator(".sf-trust")).toHaveCount(0);
  const order = await buyer.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? -1;
    return { featured: top("#featured-title"), hero: top("[data-hero]"), catalog: top("#produk"), how: top("#how-to-order-title") };
  });
  expect(order.featured).toBeLessThan(order.hero);
  expect(order.hero).toBeLessThan(order.catalog);
  expect(order.catalog).toBeLessThan(order.how);
  const prices = await buyer.locator("#product-grid .product-card:not(.hidden) .sf-num span.font-bold").allTextContents();
  const values = prices.map((text) => Number(text.replace(/\D/g, "")));
  expect(values, "cheapest first").toEqual([...values].sort((a, b) => a - b));
  expect(await buyer.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sf-accent").trim())).toBe("#0F766E");
  expect((await buyer.locator("#main-content").boundingBox())!.width).toBeLessThanOrEqual(480);
  await buyer.screenshot({ path: "test-results/admin-theme-store-1366.png", fullPage: true });
  await buyer.setViewportSize({ width: 390, height: 844 });
  await buyer.reload();
  expect(await buyer.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await buyer.screenshot({ path: "test-results/admin-theme-store-390.png", fullPage: true });

  // And back, so the suite leaves the store as it found it.
  const reset = await page.evaluate(async () => {
    const current = await (await fetch("/api/admin/settings/theme")).json();
    const settings = current.data.settings;
    settings.order = ["announcement", "hero", "trust", "featured", "catalog", "howToOrder"];
    settings.sections.announcement.enabled = false;
    settings.sections.trust.enabled = true;
    settings.sections.featured.enabled = false;
    settings.sections.howToOrder.enabled = false;
    settings.sections.catalog.title = "Produk pilihan";
    settings.sections.catalog.sort = "newest";
    const response = await fetch("/api/admin/settings/theme", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", accent: "#2563EB", settings }) });
    return response.status;
  });
  expect(reset).toBe(200);
  await buyer.close();
});

test("Tema at 390: the cards stack and fit the phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`${STORE}/admin/settings/theme`);
  await expect(page.locator('[data-theme-card="compact-market"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/admin-theme-cards-390.png", fullPage: true });
});
