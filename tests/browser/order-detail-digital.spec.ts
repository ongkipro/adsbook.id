// A digital order's page (REVIEW-2026-11-28 F-1): no shipping status, address,
// weight or parcel CRM steps; Edit changes only name and WhatsApp; an unpaid
// order offers its payment link by WhatsApp. Checked at a laptop and a phone.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);
const HEADERS = { origin: STORE, "sec-fetch-site": "same-origin", referer: `${STORE}/` };
const ready = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

test("a digital order's page shows nothing that ships and edits only the buyer", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
  const setMode = (mode: string) => page.request.put(`${STORE}/api/admin/settings`, { headers: HEADERS, data: { action: "save-catalog-mode", catalog_mode: mode } });
  // The suite's stores are physical; this spec switches to hybrid and puts that back.
  await setMode("hybrid");
  try {
    const stamp = String(Date.now()).slice(-6);
    const list = async () => {
      const body = await (await page.request.get(`${STORE}/api/admin/products`)).json();
      return (body.data?.products ?? body.data ?? []) as Array<{ slug: string; image_url?: string | null; variants: Array<{ id: number }> }>;
    };
    const image = (await list()).find((row) => row.image_url)?.image_url;
    await page.request.post(`${STORE}/api/admin/products`, {
      headers: HEADERS,
      data: { title: `Template Desain ${stamp}`, slug: `template-${stamp}`, category: "Digital", product_type: "digital", digital_access_url: "https://drive.example.test/t", is_active: true, image_url: image, variants: [{ sku: `TPL-${stamp}`, title: "ZIP", price: 59000, stock: 0 }] },
    });
    const variantId = String((await list()).find((row) => row.slug === `template-${stamp}`)!.variants[0].id);
    const placed = await (await page.request.post(`${STORE}/api/submit-order`, {
      headers: HEADERS,
      data: { submit_token: `detail-digital-${stamp}-xx`, website: "", customer_name: "Pembeli Digital", customer_phone: `0815${stamp}11`, variant_id: variantId, quantity: 1, payment_method: "qris", payment_channel: "QRIS" },
    })).json();
    expect(placed.success, JSON.stringify(placed).slice(0, 200)).toBe(true);
    const invoice = placed.order.order_number as string;

    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`${STORE}/admin/orders/${encodeURIComponent(invoice)}`);
      await ready(page);
      await expect(page.locator("[data-digital-access-panel]")).toBeVisible();
      await expect(page.locator("#order-shipping-status")).toHaveCount(0);
      await expect(page.getByText("Alamat kirim")).toHaveCount(0);
      await expect(page.getByText("Total berat")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Follow-up WhatsApp" })).toHaveCount(0);
      await expect(page.locator("[data-send-digital-payment]")).toHaveAttribute("href", /wa\.me\/.*payment/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/order-detail-digital-${width}.png`, fullPage: true });
    }

    // Edit: name and WhatsApp only.
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole("button", { name: /^Edit/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit Pembeli" })).toBeVisible();
    await expect(dialog.getByLabel("Alamat Jalan / Rumah")).toHaveCount(0);
    await expect(dialog.getByText("Kecamatan tujuan")).toHaveCount(0);
    await dialog.getByLabel("Nama Lengkap").fill("Pembeli Digital Baru");
    await dialog.getByRole("button", { name: "Simpan Perubahan" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Pembeli Digital Baru").first()).toBeVisible();

    // Closing it: an unpaid digital order is cancelled from its page, and its access stays closed.
    await page.locator("[data-close-digital-order]").click();
    await page.getByRole("dialog").getByRole("button", { name: "Batalkan pesanan" }).click();
    await expect(page.locator("[data-close-digital-order]")).toHaveCount(0);
    await expect(page.locator("[data-order-status-axes]")).toContainText("Akses ditutup");
    expect(errors).toEqual([]);
  } finally {
    await setMode("physical");
    await context.close();
  }
});
