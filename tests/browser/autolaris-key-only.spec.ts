// AUTOLARIS_INTEGRATION_SPEC §2–§4 (2026-11-17): a seller who enters only the
// AutoLaris API key is offered QRIS/VA at checkout, and the payment-only
// `/submit` goes out with courir 1 and the default area pair. Local only: the
// AutoLaris stand-in refuses a /submit without an area pair, as the live one does.
import { expect, test } from "@playwright/test";
import { PORT } from "../../playwright.config.ts";
import { origin, owner } from "./tenants.ts";

const PROVIDERS = `http://127.0.0.1:${PORT + 1}`;
// The global setup's store (dev-seed: key only since 2026-11-17, plus QRIS orders). A new
// signup here would trip the 5-per-hour signup limit the suite already spends.
const SLUG = "toko-alfa";
const STORE = origin(SLUG);

test("an API key alone opens QRIS/VA; the Lanjutan fields stay closed and empty", async ({ page }) => {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);

  await page.goto(`${STORE}/admin/profile`);
  await expect(page.locator("#autolarisKey")).toBeVisible();
  await expect(page.locator("#autolarisAdvanced")).not.toHaveAttribute("open", "");
  await expect(page.locator("#autolarisOrigin")).toBeHidden();
  await page.locator("#autolarisAdvanced summary").click();
  await expect(page.locator("#autolarisOrigin")).toHaveValue("", { timeout: 10_000 });

  const methods = await (await page.request.get(`${STORE}/api/payment-methods`)).json();
  const qris = (methods.data as Array<{ code: string; is_active: boolean }>).find((row) => row.code === "QRIS");
  expect(qris?.is_active, "QRIS offered with the key alone").toBe(true);

  // A buyer pays by QRIS through the public checkout, exactly as the order form posts it.
  const headers = { origin: STORE, "sec-fetch-site": "same-origin" };
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{ is_active: number | boolean; variants: Array<{ id: number }> }>;
  const variantId = String(rows.find((row) => row.is_active === 1 || row.is_active === true)!.variants[0].id);
  const area = (await (await page.request.get(`${STORE}/api/locations?search=${encodeURIComponent("Coblong Bandung")}`)).json()).items[0];
  const quote = await (await page.request.get(`${STORE}/api/shipping-options?${new URLSearchParams({ location_id: area.id, variant_unique_id: variantId, payment_method: "qris", city: area.city })}`)).json();
  const rateIndex = (quote.rates as Array<{ unsupported?: boolean }>).findIndex((rate) => !rate.unsupported);
  const rate = quote.rates[rateIndex];
  const placed = await page.request.post(`${STORE}/api/submit-order`, {
    headers,
    data: {
      submit_token: `key-only-${Date.now()}`, website: "", customer_name: "Pembeli QRIS", customer_phone: "081234599901",
      address: "Jl. Dago No. 1", district: area.district, city: area.city, province: area.province, location_id: area.id,
      payment_method: "qris", payment_channel: "QRIS", variant_id: variantId, quantity: 1,
      courier_service_id: rateIndex + 1, shipment_provider_code: rate.courier_code, shipping_cost: rate.price,
    },
  });
  const order = await placed.json();
  expect(order.success, JSON.stringify(order).slice(0, 300)).toBe(true);
  expect(order.order.payment_method).toBe("qris");
  expect(order.payment?.error, "the QRIS instruction was created").toBeFalsy();
  // That /submit reached the provider with courir 1 and the default area pair.
  const submit = await (await page.request.get(`${PROVIDERS}/__dev/autolaris/last-submit`)).json();
  expect(submit.courir_id).toBe(1);
  expect(submit.origin).toBe(3517100);
  expect(submit.destination).toBe(3518010);
  expect(String(submit.cod_value)).toBe("0");
});

test("a Select inside a dialog opens and picks (product Embed mode) — it used to be unclickable", async ({ page }) => {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
  await page.goto(`${STORE}/admin/products`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  // The first active product (a draft's Embed item is disabled).
  for (let index = 0; index < 6; index += 1) {
    await page.locator('button[aria-label^="Aksi produk"]:visible').nth(index).click();
    const item = page.getByRole("menuitem", { name: "Embed checkout form" });
    if (await item.count()) {
      await item.click();
      break;
    }
    await page.keyboard.press("Escape");
  }
  const mode = page.getByRole("combobox", { name: "Mode form" });
  await expect(mode).toBeVisible({ timeout: 10_000 });
  await mode.click();
  await expect(mode).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("option", { name: /^Full/ }).click();
  await expect(mode).toContainText("Full");
  await expect(page.getByRole("dialog")).toBeVisible();
});
