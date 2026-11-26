// The order page (2026-11-27 redesign): one header with the three status axes as
// text, the shipping journey as a row of steps, and quiet panels. Checked on a
// pending order (the channel choice) and on the seeded processing one, at a
// phone and a laptop width.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);
const SHOTS = process.env.ORDER_DETAIL_SHOT_DIR;

async function signIn(page: Page) {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

async function placePendingOrder(page: Page): Promise<string> {
  const headers = { origin: STORE, "sec-fetch-site": "same-origin" };
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{ is_active: number | boolean; product_type?: string; variants: Array<{ id: number }> }>;
  const physical = rows.find((row) => (row.is_active === 1 || row.is_active === true) && row.product_type !== "digital")!;
  const variantId = String(physical.variants[0].id);
  const area = (await (await page.request.get(`${STORE}/api/locations?search=${encodeURIComponent("Coblong Bandung")}`)).json()).items[0];
  const quote = await (await page.request.get(`${STORE}/api/shipping-options?${new URLSearchParams({ location_id: area.id, variant_unique_id: variantId, payment_method: "cod", city: area.city })}`)).json();
  const rateIndex = (quote.rates as Array<{ unsupported?: boolean }>).findIndex((rate) => !rate.unsupported);
  const rate = quote.rates[rateIndex];
  const placed = await page.request.post(`${STORE}/api/submit-order`, {
    headers,
    data: {
      submit_token: `order-detail-${Date.now()}`, website: "", customer_name: "Pembeli Halaman Order", customer_phone: "081234588802",
      address: "Jl. Dipatiukur No. 21", district: area.district, city: area.city, province: area.province, location_id: area.id,
      payment_method: "cod", variant_id: variantId, quantity: 1, courier_service_id: rateIndex + 1,
      shipment_provider_code: rate.courier_code, shipping_cost: rate.price, source_page_path: "/promo-dipatiukur?utm_source=fb",
    },
  });
  const order = await placed.json();
  expect(order.success, JSON.stringify(order).slice(0, 300)).toBe(true);
  return String(order.order.order_number);
}

for (const width of [390, 1366]) {
  test(`order page at ${width}: status axes as text, a journey row, no pills, no sideways scroll`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await signIn(page);
    const pending = await placePendingOrder(page);

    for (const [invoice, status, current] of [[pending, "Menunggu konfirmasi", "Dikonfirmasi"], ["INV-10001", "Diproses Mengantar", "Diproses"]] as const) {
      await page.goto(`${STORE}/admin/orders/${encodeURIComponent(invoice)}`);
      await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
      const axes = page.locator("[data-order-status-axes]");
      await expect(axes).toContainText("Pembayaran");
      await expect(axes).toContainText(`Pengiriman${status}`);
      const journey = page.locator("[data-order-journey]");
      await expect(journey.locator("li")).toHaveCount(5);
      await expect(journey.locator('[aria-current="step"]')).toContainText(current);
      // One banner per page: the shell's header. The order page's own header is not a landmark.
      expect(await page.locator("header").count(), `${invoice}: one header landmark`).toBe(1);

      const layout = await page.evaluate(() => {
        const main = document.getElementById("admin-main")!;
        const pills = [...main.querySelectorAll<HTMLElement>("*")].filter((el) => {
          const r = el.getBoundingClientRect();
          return parseFloat(getComputedStyle(el).borderTopLeftRadius) >= 999 && r.width > 16 && r.height > 8;
        }).map((el) => (el.textContent ?? "").trim().slice(0, 20));
        return { pageScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, pills };
      });
      expect(layout.pageScrollX, `${invoice}: no sideways scroll`).toBe(false);
      expect(layout.pills, `${invoice}: no pill-shaped labels; colour is a dot beside the word`).toEqual([]);
      if (SHOTS) {
        const full = await page.evaluate(() => document.getElementById("admin-main")!.scrollHeight);
        await page.setViewportSize({ width, height: Math.min(full + 80, 4000) });
        await page.screenshot({ path: `${SHOTS}/order-${invoice === pending ? "pending" : "processing"}-${width}.png` });
        await page.setViewportSize({ width, height: 900 });
      }
    }

    // The pending order: the channel choice and its action, and the landing path is a link on this store.
    await page.goto(`${STORE}/admin/orders/${encodeURIComponent(pending)}`);
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    await expect(page.getByRole("radio", { name: "Push ke Mengantar" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("link", { name: "/promo-dipatiukur?utm_source=fb" })).toHaveAttribute("href", "/promo-dipatiukur?utm_source=fb");
    // The seeded order is already at Mengantar: Edit is locked and the page says why in words.
    await page.goto(`${STORE}/admin/orders/INV-10001`);
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    await expect(page.getByRole("button", { name: "Edit pembeli & alamat" })).toBeDisabled();
    await expect(page.locator("[data-customer-locked]")).toHaveText("Data terkunci, shipment Mengantar sudah dibuat.");
    expect(errors).toEqual([]);
    await context.close();
  });
}
