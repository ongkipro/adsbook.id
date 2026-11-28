// Pesanan tertinggal holds physical and digital leads (2026-11-28). Each row
// says which kind it is, and "Jadikan order" follows the product: a digital
// lead asks for a payment method instead of an address and courier, and
// becomes a prepaid digital order the buyer pays from its order page. The
// store's catalog mode is put back whatever happens.
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

async function products(page: Page) {
  const body = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  return (body.data?.products ?? body.data ?? []) as Array<{ slug: string; image_url?: string | null; is_active: number | boolean; product_type?: string; variants: Array<{ id: number }> }>;
}

async function digitalVariant(page: Page, stamp: string) {
  const image = (await products(page)).find((row) => row.image_url)?.image_url;
  const response = await page.request.post(`${STORE}/api/admin/products`, {
    headers: HEADERS,
    data: {
      title: `Kelas Online ${stamp}`, slug: `kelas-online-${stamp}`, category: "Digital", product_type: "digital",
      digital_access_url: "https://drive.example.test/kelas", is_active: true, image_url: image,
      variants: [{ sku: `KELAS-${stamp}`, title: "Akses", price: 99000, stock: 0 }],
    },
  });
  expect(response.ok(), (await response.text()).slice(0, 300)).toBe(true);
  return String((await products(page)).find((row) => row.slug === `kelas-online-${stamp}`)!.variants[0].id);
}

async function seedLead(page: Page, name: string, phone: string, variantId: string) {
  const res = await page.request.post(`${STORE}/api/record-abandoned-order`, {
    headers: HEADERS,
    data: { customer_name: name, customer_phone: phone, variant_id: variantId },
  });
  const body = await res.json();
  expect(body.success, JSON.stringify(body).slice(0, 200)).toBe(true);
  return String(body.order_number);
}

test("a digital lead converts into a prepaid digital order without address or courier; a physical lead keeps the shipping form", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await signIn(page);
  try {
    await setMode(page, "hybrid");
    const stamp = String(Date.now()).slice(-6);
    const digitalName = `Lead Digital ${stamp}`;
    const physicalName = `Lead Fisik ${stamp}`;
    const digitalLead = await seedLead(page, digitalName, `0813${stamp}41`, await digitalVariant(page, stamp));
    const physicalId = String((await products(page)).find((row) => (row.is_active === 1 || row.is_active === true) && row.product_type !== "digital")!.variants[0].id);
    await seedLead(page, physicalName, `0813${stamp}42`, physicalId);

    await page.goto(`${STORE}/admin/orders/abandoned?search=${stamp}`);
    await ready(page);
    const digitalRow = page.getByRole("article", { name: digitalName });
    const physicalRow = page.getByRole("article", { name: physicalName });
    await expect(digitalRow.locator("[data-lead-kind]")).toHaveText("Digital");
    await expect(physicalRow.locator("[data-lead-kind]")).toHaveText("Fisik");
    // A hybrid store filters the queue by kind.
    await page.getByLabel("Jenis produk").click();
    await page.getByRole("menuitemradio", { name: /^Produk digital/ }).click();
    await expect(digitalRow).toBeVisible();
    await expect(physicalRow).toHaveCount(0);
    await page.getByLabel("Jenis produk").click();
    await page.getByRole("menuitemradio", { name: "Semua jenis" }).click();
    await expect(physicalRow).toBeVisible();

    // A physical lead: the shipping form, unchanged.
    await physicalRow.getByRole("button", { name: "Jadikan order" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit & jadikan order" })).toBeVisible();
    await expect(dialog.getByLabel("Alamat lengkap")).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Metode pembayaran" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(dialog).toHaveCount(0);

    // A digital lead: payment instead of address and courier.
    await digitalRow.getByRole("button", { name: "Jadikan order" }).click();
    await expect(dialog.getByRole("heading", { name: "Jadikan order produk digital" })).toBeVisible();
    await expect(dialog.getByLabel("Alamat lengkap")).toHaveCount(0);
    await expect(dialog.getByText("Kurir & ongkir")).toHaveCount(0);
    const methods = dialog.getByRole("radiogroup", { name: "Metode pembayaran" });
    await expect(methods.getByRole("radio").first()).toBeVisible();
    await expect(methods.getByRole("radio", { name: /COD/ })).toHaveCount(0);
    await expect(dialog.getByText("Rp99.000", { exact: true })).toBeVisible();
    // Submitting with no method points at the payment group.
    await dialog.getByRole("button", { name: "Jadikan order digital" }).click();
    await expect(dialog.getByText("Pilih metode pembayaran.")).toBeVisible();
    await page.screenshot({ path: "test-results/lead-convert-digital-1366.png" });
    await methods.getByRole("radio", { name: /QRIS/ }).click();
    await dialog.getByRole("button", { name: "Jadikan order digital" }).click();

    // It lands on the order page as a digital order with its payment pending.
    const orderNumber = digitalLead.replace(/^ABN-/, "INV-");
    await page.waitForURL(new RegExp(`/admin/orders/${orderNumber}$`), { timeout: 30_000 });
    await ready(page);
    const detail = await (await page.request.get(`${STORE}/api/admin/orders/${orderNumber}`)).json();
    const order = detail.data?.order ?? detail.data;
    expect(order.fulfillment_type ?? order.fulfillmentType).toBe("digital");
    expect(order.payment_method ?? order.paymentMethod).toBe("qris");
    // The digital list holds it; the physical one does not.
    await page.goto(`${STORE}/admin/orders/digital?search=${stamp}`);
    await ready(page);
    await expect(page.getByLabel("Tabel order desktop")).toContainText(orderNumber);
    // Its WhatsApp column offers the payment link, not the parcel CRM steps.
    const waCell = page.getByLabel("Tabel order desktop").locator("[data-digital-wa]").first();
    await expect(waCell).toHaveAttribute("data-digital-wa", "Kirim link bayar");
    await expect(waCell.getByRole("link", { name: "Kirim link bayar" })).toHaveAttribute("href", /wa\.me\/.*payment/);
    await expect(page.getByLabel("Tabel order desktop").getByRole("button", { name: "Welcome" })).toHaveCount(0);
    await page.goto(`${STORE}/admin/orders?search=${stamp}`);
    await ready(page);
    await expect(page.getByLabel("Tabel order desktop")).not.toContainText(orderNumber);

    // A phone: the dialog's payment choices fit without a horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${STORE}/admin/orders/abandoned?search=${stamp}`);
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await setMode(page, "physical");
    await context.close();
  }
});
