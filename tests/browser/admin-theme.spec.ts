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

  // Atur beranda: banner editor and the settings.
  await compact.getByRole("link", { name: "Atur beranda" }).click();
  await page.waitForURL(/\/admin\/settings\/theme\/beranda$/);
  await expect(page.getByRole("heading", { level: 2, name: "Atur beranda" })).toBeVisible();
  await expect(page.getByLabel("Pilih gambar banner")).toBeAttached();
  await page.getByRole("switch", { name: "Strip kepercayaan" }).click();
  await page.getByLabel("Judul", { exact: true }).fill("Koleksi minggu ini");
  // A too-light accent is refused with the reason, and nothing changes.
  await page.getByLabel("Kode warna").fill("#FACC15");
  await page.getByRole("button", { name: "Simpan & terapkan" }).click();
  await expect(page.getByText(/terlalu terang untuk tombol/)).toBeVisible();
  await page.getByRole("radio", { name: "#0F766E" }).click();
  await page.getByRole("button", { name: "Simpan & terapkan" }).click();
  await expect(page.getByText("Pengaturan beranda tersimpan dan langsung tampil di toko.")).toBeVisible();
  await page.screenshot({ path: "test-results/admin-theme-beranda-1366.png", fullPage: true });

  // The storefront, as a buyer (no session cookie): the new heading, no trust strip, the accent.
  const buyer = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await buyer.goto(`${STORE}/`);
  await expect(buyer.getByRole("heading", { name: "Koleksi minggu ini" })).toBeVisible();
  await expect(buyer.locator(".sf-trust")).toHaveCount(0);
  expect(await buyer.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sf-accent").trim())).toBe("#0F766E");
  await expect(buyer.locator("#product-grid .sf-card").first()).toBeVisible();

  // Always the 480px column, on a wide screen too.
  expect((await buyer.locator("#main-content").boundingBox())!.width).toBeLessThanOrEqual(480);
  await buyer.screenshot({ path: "test-results/admin-theme-store-1366.png" });

  // And back, so the suite leaves the store as it found it.
  await page.goto(`${STORE}/admin/settings/theme/beranda`);
  await page.getByRole("switch", { name: "Strip kepercayaan" }).click();
  await page.getByLabel("Judul", { exact: true }).fill("Produk pilihan");
  await page.getByRole("radio", { name: "#2563EB" }).click();
  await page.getByRole("button", { name: "Simpan & terapkan" }).click();
  await expect(page.getByText("Pengaturan beranda tersimpan dan langsung tampil di toko.")).toBeVisible();
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
