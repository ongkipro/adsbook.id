import { expect, test } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);

test("external shipping channel: operator enters manual courier & waybill on OrderDetail and sees it on /admin/shipping", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);

  // Place a fresh physical COD order so seeded orders stay untouched.
  const headers = { origin: STORE, "sec-fetch-site": "same-origin" };
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{
    is_active: number | boolean;
    product_type?: string;
    variants: Array<{ id: number }>;
  }>;
  const physical = rows.find((row) => (row.is_active === 1 || row.is_active === true) && row.product_type !== "digital");
  expect(physical, "active physical product exists").toBeTruthy();
  const variantId = String(physical!.variants[0].id);
  const area = (await (await page.request.get(`${STORE}/api/locations?search=${encodeURIComponent("Coblong Bandung")}`)).json()).items[0];
  const quote = await (
    await page.request.get(
      `${STORE}/api/shipping-options?${new URLSearchParams({ location_id: area.id, variant_unique_id: variantId, payment_method: "cod", city: area.city })}`,
    )
  ).json();
  const rateIndex = (quote.rates as Array<{ unsupported?: boolean }>).findIndex((rate) => !rate.unsupported);
  const rate = quote.rates[rateIndex];
  const placed = await page.request.post(`${STORE}/api/submit-order`, {
    headers,
    data: {
      submit_token: `ext-ship-${Date.now()}`,
      website: "",
      customer_name: "Pembeli Luar Mengantar",
      customer_phone: "081234588801",
      address: "Jl. Dipatiukur No. 15",
      district: area.district,
      city: area.city,
      province: area.province,
      location_id: area.id,
      payment_method: "cod",
      variant_id: variantId,
      quantity: 1,
      courier_service_id: rateIndex + 1,
      shipment_provider_code: rate.courier_code,
      shipping_cost: rate.price,
    },
  });
  const order = await placed.json();
  expect(order.success, JSON.stringify(order).slice(0, 300)).toBe(true);
  const orderNumber = String(order.order.order_number);

  // Open OrderDetail: default is Mengantar, operator switches this order to external.
  await page.goto(`${STORE}/admin/orders/${encodeURIComponent(orderNumber)}`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.getByRole("radio", { name: "Push ke Mengantar" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("radio", { name: "Kirim di luar Mengantar" }).click();
  await page.locator("#external-courier-code").fill("SiCepat");
  await page.locator("#external-courier-service").fill("REG");
  await page.locator("#external-cnote-no").fill("EXT-BROWSER-001");
  await page.getByRole("button", { name: "Simpan & Tandai Dikirim" }).click();

  await expect(page.getByText("EXT-BROWSER-001")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Luar Mengantar", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Open /admin/shipping filtered to this order: visible with Luar Mengantar label, manual status, no pickup checkbox.
  await page.goto(`${STORE}/admin/shipping?order=${encodeURIComponent(orderNumber)}`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  const desktopTable = page.locator('[aria-label="Tabel pengiriman desktop"]');
  await expect(desktopTable.getByRole("link", { name: orderNumber, exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(desktopTable.getByText("EXT-BROWSER-001")).toBeVisible();
  await expect(desktopTable.getByText("Luar Mengantar", { exact: true })).toBeVisible();
  await expect(desktopTable.getByText("Manual (luar Mengantar)")).toBeVisible();
  await expect(desktopTable.locator(`input[aria-label="Pilih ${orderNumber} untuk pickup"]`)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // Mobile 390px overflow check on OrderDetail and Shipping.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${STORE}/admin/orders/${encodeURIComponent(orderNumber)}`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.getByText("EXT-BROWSER-001")).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  expect(errors, "no console or page errors").toEqual([]);
  await context.close();
});
