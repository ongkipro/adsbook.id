// Pesanan split by kind (2026-11-28): a hybrid store's Pesanan opens a submenu
// of Produk fisik, Produk digital and Pesanan tertinggal, each list holds its
// own kind with its own columns, a search on one list points at matches on the
// other, and a single-mode store keeps one list. Checked at a laptop and a
// phone width. The store's catalog mode is put back whatever happens.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);
const HEADERS = { origin: STORE, "sec-fetch-site": "same-origin", referer: `${STORE}/` };

async function signIn(page: Page) {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

const ready = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

async function setMode(page: Page, mode: "physical" | "digital" | "hybrid") {
  const response = await page.request.put(`${STORE}/api/admin/settings`, { headers: HEADERS, data: { action: "save-catalog-mode", catalog_mode: mode } });
  expect(response.status(), await response.text()).toBe(200);
}

/** A digital product with an https access link, created the way the product form saves it. */
async function digitalVariant(page: Page, stamp: string) {
  // An active product needs a picture: borrow one the store already uploaded.
  const existing = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const image = ((existing.data?.products ?? existing.data ?? []) as Array<{ image_url?: string | null }>).find((row) => row.image_url)?.image_url;
  const response = await page.request.post(`${STORE}/api/admin/products`, {
    headers: HEADERS,
    data: {
      title: `E-book Uji ${stamp}`, slug: `ebook-uji-${stamp}`, category: "Digital", product_type: "digital",
      digital_access_url: "https://drive.example.test/ebook-uji", is_active: true, image_url: image,
      variants: [{ sku: `EBOOK-${stamp}`, title: "PDF", price: 49000, stock: 0 }],
    },
  });
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body).slice(0, 300)).toBe(true);
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{ slug: string; variants: Array<{ id: number }> }>;
  return String(rows.find((row) => row.slug === `ebook-uji-${stamp}`)!.variants[0].id);
}

async function physicalVariant(page: Page) {
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{ is_active: number | boolean; product_type?: string; variants: Array<{ id: number }> }>;
  return String(rows.find((row) => (row.is_active === 1 || row.is_active === true) && row.product_type !== "digital")!.variants[0].id);
}

test("a hybrid store's Pesanan splits into Produk fisik, Produk digital and Pesanan tertinggal", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await signIn(page);
  try {
    await setMode(page, "hybrid");
    const stamp = String(Date.now()).slice(-6);
    const buyer = `Pembeli Jenis ${stamp}`;
    const phone = `0812${stamp}77`;

    // One digital QRIS order (the local AutoLaris stand-in) and one physical COD order, same buyer.
    const digital = await page.request.post(`${STORE}/api/submit-order`, {
      headers: HEADERS,
      data: { submit_token: `orders-by-kind-dig-${stamp}`, website: "", customer_name: buyer, customer_phone: phone, variant_id: await digitalVariant(page, stamp), quantity: 1, payment_method: "qris", payment_channel: "QRIS" },
    });
    const digitalBody = await digital.json();
    expect(digitalBody.success, JSON.stringify(digitalBody).slice(0, 300)).toBe(true);
    const area = (await (await page.request.get(`${STORE}/api/locations?search=${encodeURIComponent("Coblong Bandung")}`)).json()).items[0];
    const physicalId = await physicalVariant(page);
    const quote = await (await page.request.get(`${STORE}/api/shipping-options?${new URLSearchParams({ location_id: area.id, variant_unique_id: physicalId, payment_method: "cod", city: area.city })}`)).json();
    const rateIndex = (quote.rates as Array<{ unsupported?: boolean }>).findIndex((rate) => !rate.unsupported);
    const rate = quote.rates[rateIndex];
    const physical = await page.request.post(`${STORE}/api/submit-order`, {
      headers: HEADERS,
      data: {
        submit_token: `orders-by-kind-phy-${stamp}`, website: "", customer_name: buyer, customer_phone: phone,
        address: "Jl. Dago No. 2", district: area.district, city: area.city, province: area.province, location_id: area.id,
        payment_method: "cod", variant_id: physicalId, quantity: 1,
        courier_service_id: rateIndex + 1, shipment_provider_code: rate.courier_code, shipping_cost: rate.price,
      },
    });
    const physicalBody = await physical.json();
    expect(physicalBody.success, JSON.stringify(physicalBody).slice(0, 300)).toBe(true);

    // The submenu: three children under Pesanan, in that order.
    await page.goto(`${STORE}/admin/orders`);
    await ready(page);
    const sub = page.locator('[data-sidebar="menu-sub"]').first();
    await expect(sub.getByRole("link")).toHaveText(["Produk fisik", "Produk digital", "Pesanan tertinggal"]);
    await expect(sub.getByRole("link", { name: "Produk fisik" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Pesanan produk fisik" })).toBeVisible();

    // Produk fisik: the physical order with shipping and RTS, never the digital one.
    await page.getByLabel("Cari pesanan").fill(stamp);
    const desktop = page.getByLabel("Tabel order desktop");
    await expect(desktop.getByRole("row")).toHaveCount(2);
    await expect(desktop.getByRole("columnheader", { name: "Risiko RTS" })).toBeVisible();
    await expect(desktop.getByRole("columnheader", { name: "Pengiriman" })).toBeVisible();
    await expect(desktop).toContainText(physicalBody.order.order_number);
    await expect(desktop).not.toContainText(digitalBody.order.order_number);
    // The same search matched a digital order: the list says so and links there.
    const hint = page.getByRole("status").filter({ hasText: "produk digital juga cocok" });
    await expect(hint).toContainText("1 pesanan produk digital");
    await page.screenshot({ path: "test-results/orders-physical-1366.png", fullPage: true });
    await hint.getByRole("link", { name: "Lihat di Produk Digital" }).click();

    // Produk digital: access instead of shipping, no RTS, digital chips.
    await page.waitForURL(/\/admin\/orders\/digital\?search=/);
    await ready(page);
    await expect(page.getByRole("heading", { level: 2, name: "Pesanan produk digital" })).toBeVisible();
    await expect(page.locator('[data-sidebar="menu-sub"]').first().getByRole("link", { name: "Produk digital" })).toHaveAttribute("aria-current", "page");
    await expect(desktop.getByRole("row")).toHaveCount(2);
    await expect(desktop).toContainText(digitalBody.order.order_number);
    await expect(desktop.getByRole("columnheader", { name: "Akses produk" })).toBeVisible();
    await expect(desktop.getByRole("columnheader", { name: "Risiko RTS" })).toHaveCount(0);
    await expect(desktop.locator(`[data-digital-access="Menunggu pembayaran"]`)).toBeVisible();
    // The cards and the count come with the first paint, not after a refetch.
    await expect(page.getByText("Menampilkan 1–1 dari 1 order")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Filter cepat status order" }).getByRole("button")).toHaveText([/^Semua/, /^Menunggu pembayaran/, /^Akses terbuka/, /^Batal/]);
    await expect(page.getByText("Lunas, belum dibuka")).toBeVisible();
    await page.screenshot({ path: "test-results/orders-digital-1366.png", fullPage: true });
    await expect(page.locator("#admin-main header").getByRole("link", { name: "Pengiriman", exact: true }), "no shipping shortcut on the digital list").toHaveCount(0);
    // Its row menu offers neither an RTS check nor a Mengantar push.
    await desktop.getByRole("button", { name: `Aksi order ${digitalBody.order.order_number}` }).click();
    await expect(page.getByRole("menuitem", { name: "Cek risiko RTS" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /Mengantar/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The order page returns to the list it belongs to.
    await page.goto(`${STORE}/admin/orders/${encodeURIComponent(digitalBody.order.order_number)}`);
    await ready(page);
    await expect(page.getByRole("link", { name: "Pesanan produk digital" })).toHaveAttribute("href", "/admin/orders/digital");

    // Dashboard: the digital unpaid card opens the digital list.
    await page.goto(`${STORE}/admin/dashboard`);
    await ready(page);
    const card = page.locator('a[href="/admin/orders/digital?payment_status=unpaid"]').first();
    await expect(card).toContainText("Pesanan digital belum dibayar");

    // A phone: the card shows the access state, no RTS pill, no horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${STORE}/admin/orders/digital?search=${stamp}`);
    await ready(page);
    const cardOnPhone = page.getByLabel("Daftar order mobile").locator("article").first();
    await expect(cardOnPhone.locator(`[data-digital-access="Menunggu pembayaran"]`)).toBeVisible();
    await expect(cardOnPhone.getByText(/Risiko|Rendah|Tinggi|Belum dinilai/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/orders-digital-390.png", fullPage: true });

    // A single-mode store keeps one list: no submenu split, the digital URL folds back.
    await setMode(page, "digital");
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`${STORE}/admin/orders/digital?search=${stamp}`);
    await page.waitForURL(new RegExp(`/admin/orders\\?search=${stamp}$`));
    await ready(page);
    await expect(page.getByRole("heading", { level: 2, name: "Pesanan", exact: true })).toBeVisible();
    await expect(page.locator('[data-sidebar="menu-sub"]').first().getByRole("link")).toHaveText(["Pesanan tertinggal"]);
    expect(errors).toEqual([]);
  } finally {
    await setMode(page, "physical");
    await context.close();
  }
});
