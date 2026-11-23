// DIGITAL-PRODUCTS-SPEC (2026-11-18) end to end in a real browser, local only:
// a seller signs up choosing Produk Digital, sees a menu with nothing that
// ships, adds a digital product with its https access link, and opens the
// store with an AutoLaris key alone (no warehouse, no Mengantar key). A buyer
// pays by QRIS with name, WhatsApp and email only; the link stays hidden until
// the stand-in settles it, then /thanks unlocks it, the first open is
// stamped, and a refund closes it again. Paket 1: a price edit reaches the
// next anonymous visitor at once, not in two minutes.
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { PORT } from "../../playwright.config.ts";
import { origin, PLATFORM, signUpThroughWizard } from "./tenants.ts";

const PROVIDERS = `http://127.0.0.1:${PORT + 1}`;
const SLUG = "toko-ebook-uji";
const STORE = origin(SLUG);
const OWNER = { email: "owner@toko-ebook-uji.local.test", password: "password-digital-123" };
const ACCESS_URL = "https://drive.example.test/ebook-resep-rahasia";
const ACCESS_NOTE = "Password PDF: RESEP2026";
const PRODUCT_SLUG = "ebook-resep-nusantara";
const shots = process.env.DIG_SHOT_DIR;

/** ADR-041: a new store is in Preview Mode; the clock on the local control plane is the lever (as billing.spec.ts). */
function subscribe(slug: string) {
  const result = spawnSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--local", "-c", "dist/server/wrangler.dev-local.json", "--persist-to", ".wrangler/browser-test-state",
      "--command", `UPDATE tenants SET subscription_ends_at = '2099-01-01T00:00:00.000Z', grace_ends_at = '2099-01-03T00:00:00.000Z', cache_version = cache_version + 1 WHERE slug = '${slug}'`],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CF_API_TOKEN: "" } },
  );
  if (result.status !== 0) throw new Error(`subscribe failed: ${result.stderr}`);
}

/** An admin write the way the admin's own pages send it (same origin, so the CSRF gate passes). */
async function adminFetch(page: Page, path: string, method: string, body?: unknown) {
  return page.evaluate(async ([path, method, body]) => {
    const response = await fetch(path as string, { method: method as string, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  }, [path, method, body] as const);
}

/** A 600 × 600 PNG drawn in the page, handed to the real file input. */
async function productImage(page: Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    // A narrow portrait (300 x 900): the catalog copy must come out a padded square.
    canvas.width = 300;
    canvas.height = 900;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2563eb";
    context.fillRect(0, 0, 300, 900);
    context.fillStyle = "#ffffff";
    context.fillRect(60, 200, 180, 400);
    return canvas.toDataURL("image/png");
  });
  return { name: "ebook.png", mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1], "base64") };
}

test("digital store: signup → menu without shipping → digital product → open without warehouse → QRIS → access unlocked, stamped, revoked", async ({ page, browser }) => {
  test.setTimeout(300_000);
  // The suite's other signups share this address's 5-per-hour allowance; this one comes from its own.
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.88" });
  await page.setViewportSize({ width: 1366, height: 900 });

  // 1. Signup choosing Produk Digital.
  await page.goto(`${PLATFORM}/daftar`);
  await expect(page.getByRole("radio", { name: /Produk Fisik/ })).toBeChecked();
  await signUpThroughWizard(page, { storeName: "Toko Ebook Uji", slug: SLUG, email: OWNER.email, password: OWNER.password, whatsapp: "0812-3456-7801", catalog: "digital" });
  await page.waitForURL(new RegExp(`^${STORE}/admin`), { timeout: 60_000 });

  // 2. A menu with nothing that ships, and a three-step digital checklist.
  await page.goto(`${STORE}/admin/dashboard`);
  await expect(page.getByRole("link", { name: /^Pesanan/ }).first()).toBeVisible();
  for (const href of ["/admin/shipping", "/admin/expeditions", "/admin/check", "/admin/settings/warehouse"]) {
    await expect(page.locator(`a[href="${href}"]`), href).toHaveCount(0);
  }
  await expect(page.getByText("Tambah produk digital pertama + link akses")).toBeVisible();
  await expect(page.getByText("Lengkapi alamat pickup / gudang utama")).toHaveCount(0);

  // 3. A digital product through the real form: locked type, access card, no weight field.
  await page.goto(`${STORE}/admin/products/new`);
  // Typed before React hydrates, a value is wiped by the first render.
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.locator("[data-product-type-locked=digital]")).toBeVisible();
  await expect(page.getByText("Berat kirim")).toHaveCount(0);
  await page.getByLabel("Link akses utama").fill("http://drive.example.test/x");
  await page.getByLabel("Nama produk").fill("E-book Resep Nusantara");
  await page.getByLabel("Slug").fill(PRODUCT_SLUG);
  await page.locator("#product-image").setInputFiles(await productImage(page));
  // Processed in the browser and stored: the preview shows the uploaded copy.
  await expect(page.locator('img[src*="/assets/uploads/"]').first()).toBeVisible({ timeout: 30_000 });
  // The catalog copy beside it: a JPEG square at least 500 px a side, the photo
  // centred on white (Meta and Google refuse a short side under 500 px).
  const uploaded = await page.locator('img[src*="/assets/uploads/"]').first().getAttribute("src");
  const feedCopy = await page.evaluate(async (src) => {
    const response = await fetch(src!.replace(/\.webp$/, ".jpg"));
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const corner = [...context.getImageData(2, 2, 1, 1).data.slice(0, 3)];
    const centre = [...context.getImageData(bitmap.width / 2, 20, 1, 1).data.slice(0, 3)];
    return { type: response.headers.get("content-type"), standIn: response.headers.get("x-asset-stand-in"), width: bitmap.width, height: bitmap.height, corner, centre };
  }, uploaded);
  expect(feedCopy.type).toBe("image/jpeg");
  expect(feedCopy.standIn, "the stored copy, not the WebP standing in for it").toBeNull();
  expect([feedCopy.width, feedCopy.height]).toEqual([900, 900]);
  expect(feedCopy.corner.every((channel) => channel > 245), "white padding").toBe(true);
  expect(feedCopy.centre[2] > 200 && feedCopy.centre[0] < 80, "the blue photo in the middle").toBe(true);
  await page.getByLabel(/^Nama varian/).fill("PDF");
  await page.getByLabel("SKU").fill("EBOOK-PDF");
  await page.getByRole("spinbutton", { name: "Harga jual Rp" }).fill("49000");
  await page.getByRole("button", { name: "Simpan Produk" }).click();
  expect(await page.locator("#digitalAccessUrl").evaluate((input: HTMLInputElement) => input.validity.valid), "an http link is refused").toBe(false);
  expect(page.url()).toContain("/admin/products/new");
  await page.getByLabel("Link akses utama").fill(ACCESS_URL);
  await page.locator("#digitalAccessNote").fill(ACCESS_NOTE);
  if (shots) await page.screenshot({ path: `${shots}/dig-admin-product-1366.png`, fullPage: true });
  const invalid = await page.evaluate(() => [...document.querySelectorAll("form input, form textarea")].filter((el) => !(el as HTMLInputElement).checkValidity()).map((el) => `${el.tagName}#${el.id}[${(el as HTMLInputElement).name}]=${(el as HTMLInputElement).value}:${(el as HTMLInputElement).validationMessage}`));
  expect(invalid, "every product field is valid").toEqual([]);
  await expect(page.getByRole("button", { name: "Simpan Produk" })).toBeEnabled();
  await page.getByRole("button", { name: "Simpan Produk" }).click();
  await page.waitForURL(`${STORE}/admin/products`, { timeout: 30_000 });

  // 4. Open with an AutoLaris key alone: no warehouse, no Mengantar key, no courier.
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  expect((await visitor.goto(`${STORE}/`))!.status(), "not ready before payment").toBe(503);
  const saved = await adminFetch(page, "/api/admin/settings", "PUT", { action: "save-integrations", integrations: { autolaris_api_key: "dev", autolaris_base_url: PROVIDERS, mengantar_base_url: PROVIDERS } });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  subscribe(SLUG);
  expect((await visitor.goto(`${STORE}/?ready=${Date.now()}`))!.status(), "ready with no warehouse and no Mengantar key").toBe(200);

  // 5. The access link reaches no public surface.
  const productPage = await visitor.goto(`${STORE}/produk/${PRODUCT_SLUG}`);
  expect(productPage!.status()).toBe(200);
  expect(await productPage!.text()).not.toContain("drive.example.test");
  for (const feed of ["google-catalog.xml", "meta-catalog.xml", "tiktok-catalog.xml"]) {
    const xml = await (await visitor.request.get(`${STORE}/feed/${feed}`)).text();
    expect(xml, feed).not.toContain("drive.example.test");
    expect(xml, `${feed} carries no digital item`).not.toContain("E-book Resep Nusantara");
  }

  // 6. The digital checkout at 390: name, WhatsApp, email, QRIS; no address, no COD.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto(`${STORE}/produk/${PRODUCT_SLUG}?checkout=${Date.now()}`);
  const form = visitor.locator("[data-digital-form]");
  await expect(form).toBeVisible();
  await expect(form.locator('[name="address"]')).toHaveCount(0);
  await expect(form.getByRole("radio", { name: /QRIS/ })).toBeVisible({ timeout: 15_000 });
  await expect(form.getByRole("radio", { name: /COD/ })).toHaveCount(0);
  // Grey until name, WhatsApp and a payment method are set (owner, 2026-11-23).
  const pay = form.getByRole("button", { name: /Bayar/ });
  await expect(pay).toHaveAttribute("data-state", "disabled");
  // Field rules match the COD form (owner, 2026-11-23): letters never stay in
  // the WhatsApp field, 0812… becomes 62812…, an email needs its @ and domain.
  const name = form.getByLabel("Nama lengkap");
  const phone = form.getByLabel("Nomor WhatsApp aktif");
  const email = form.getByLabel("Email (opsional)");
  // A required field left empty turns red with its message; the optional email does not.
  await name.focus();
  await phone.focus();
  await email.focus();
  await email.blur();
  await expect(form.locator(".field-feedback").filter({ hasText: "Maaf, nama Anda belum terisi." })).toBeVisible();
  await expect(form.locator(".field-feedback").filter({ hasText: "Maaf, nomor WhatsApp Anda belum terisi." })).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  // The danger red (--sf-danger #C81E1E), once the border transition settles.
  await expect(name).toHaveCSS("border-top-color", "rgb(200, 30, 30)");
  await form.locator(".field-grid").screenshot({ path: "test-results/digital-form-empty-390.png" });
  // Tapping the grey button with nothing filled marks every required field and focuses the first.
  await pay.click({ force: true });
  await expect(name).toBeFocused();
  await name.pressSequentially("Budi123 Pembeli");
  await expect(name).toHaveValue("Budi Pembeli");
  await phone.pressSequentially("08abc12-3456-7801");
  await expect(phone).toHaveValue("6281234567801");
  await phone.fill("0212345678");
  await phone.blur();
  await expect(form.locator(".field-feedback").filter({ hasText: "nomor seluler Indonesia" })).toBeVisible();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await phone.fill("081234567801");
  await phone.blur();
  await expect(phone).toHaveAttribute("aria-invalid", "false");
  await form.getByRole("radio", { name: /QRIS/ }).check();
  await expect(pay).toHaveAttribute("data-state", "ready");
  await email.fill("budi@gmail");
  await email.blur();
  await expect(form.locator(".field-feedback").filter({ hasText: "Format email belum benar" })).toBeVisible();
  await expect(pay, "a malformed email keeps the button grey").toHaveAttribute("data-state", "disabled");
  await pay.click({ force: true });
  await expect(email).toBeFocused();
  await email.fill("Budi@Example.test");
  await email.blur();
  await expect(email).toHaveValue("budi@example.test");
  await expect(form.locator(".field-feedback:visible")).toHaveCount(0);
  await expect(pay).toHaveAttribute("data-state", "ready");
  // The same 8px between fields as the COD forms.
  const fieldGaps = await form.evaluate((root) => {
    const fields = [...root.querySelectorAll(".form-field")].filter((field) => (field as HTMLElement).offsetParent);
    return [...new Set(fields.slice(1).map((field, index) => Math.round(field.getBoundingClientRect().top - fields[index].getBoundingClientRect().bottom)))];
  });
  expect(fieldGaps, "8px between fields, as the COD forms").toEqual([8]);
  await form.screenshot({ path: "test-results/digital-form-ready-390.png" });
  await form.scrollIntoViewIfNeeded();
  if (shots) await visitor.screenshot({ path: `${shots}/dig-checkout-390.png`, fullPage: true });
  // COD is refused by the server whatever a request says.
  const variantId = await form.locator('input[name="variant"]').first().getAttribute("value");
  const cod = await visitor.evaluate(async (variant) => {
    const response = await fetch("/api/submit-order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submit_token: `dig_cod_${Date.now()}_x`, website: "", customer_name: "Budi", customer_phone: "6281234567801", variant_id: variant, quantity: 1, payment_method: "cod" }) });
    return { status: response.status, code: (await response.json()).code };
  }, variantId);
  expect(cod).toEqual({ status: 422, code: "DIGITAL_REQUIRES_PREPAID" });
  await form.getByRole("button", { name: /Bayar/ }).click();
  await visitor.waitForURL(/\/payment/, { timeout: 30_000 });
  // /payment moves the locator out of the URL; the checkout left it in thanks_state.
  const stored = await visitor.evaluate(() => JSON.parse(sessionStorage.getItem("thanks_state") || "{}"));
  const params = new URLSearchParams({ o: String(stored.order_pk ?? ""), t: String(stored.status_token ?? "") });
  const locator = params.toString();
  expect(stored.fulfillment_type).toBe("digital");
  const status = async (extra: Record<string, unknown> = {}) =>
    (await visitor.request.post(`${STORE}/api/order-status`, { data: { order_pk: params.get("o"), status_token: params.get("t"), ...extra } })).json();
  const unpaid = await status();
  expect(unpaid.fulfillment_type, JSON.stringify(unpaid).slice(0, 400)).toBe("digital");
  expect(unpaid.is_paid).toBe(false);
  expect(unpaid.digital_access, "no link while unpaid").toBeNull();
  expect(JSON.stringify(unpaid)).not.toContain("drive.example.test");
  // The payment-only /submit went out with the default area pair: no warehouse needed.
  const submitted = await (await visitor.request.get(`${PROVIDERS}/__dev/autolaris/last-submit`)).json();
  expect([submitted.origin, submitted.destination, submitted.courir_id]).toEqual([3517100, 3518010, 1]);

  // 7. Settled at the stand-in, seen by the hourly job: paid, delivered, unlocked.
  const held = (await (await visitor.request.get(`${PROVIDERS}/__dev/autolaris/payments`)).json()) as Array<{ transaction_id: string; paid: boolean; total: number; receiver?: string }>;
  const payment = held.filter((row) => !row.paid && row.receiver === "Budi Pembeli").at(-1);
  expect(payment, "the stand-in holds the QRIS instruction").toBeTruthy();
  await visitor.request.post(`${PROVIDERS}/__dev/autolaris/pay?transaction_id=${encodeURIComponent(payment!.transaction_id)}`);
  // The tenant's hourly alarm reads AutoLaris Advice; the test takes the operator's
  // on-demand path instead — the same paid transition (enqueuePurchaseForPaidOrder):
  // a provider inquiry, then a confirmation that must match its reference and amount.
  const queue = await adminFetch(page, `/api/admin/payment-reconciliation?search=${encodeURIComponent(String(unpaid.order_number))}`, "GET");
  const transaction = (queue.json.data.transactions as Array<{ transaction_id: number; order_number: string; provider_transaction_id: string; total_amount: number }>)
    .find((row) => row.order_number === unpaid.order_number);
  expect(transaction, JSON.stringify(queue.json).slice(0, 300)).toBeTruthy();
  const inquiry = await adminFetch(page, "/api/admin/payment-reconciliation", "POST", { action: "inquire", transaction_id: transaction!.transaction_id });
  expect(inquiry.status, JSON.stringify(inquiry.json)).toBe(200);
  const confirmed = await adminFetch(page, "/api/admin/payment-reconciliation", "POST", {
    transaction_id: transaction!.transaction_id,
    verified_amount: transaction!.total_amount,
    provider_reference: transaction!.provider_transaction_id,
    note: "Lunas di AutoLaris (uji lokal).",
    confirmed: true,
  });
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  expect((await status()).is_paid).toBe(true);
  const paid = await status();
  expect(paid.status, "a paid digital order is delivered at once").toBe("delivered");
  expect(paid.digital_access).toMatchObject({ url: ACCESS_URL, note: ACCESS_NOTE, product_name: "E-book Resep Nusantara", accessed_at: null });

  await visitor.goto(`${STORE}/thanks#${locator}`);
  const card = visitor.locator("#digital-access");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(visitor.getByRole("link", { name: "Buka / Akses Produk Sekarang ↗" })).toHaveAttribute("href", ACCESS_URL);
  await expect(visitor.locator("#digital-access-note")).toHaveText(ACCESS_NOTE);
  if (shots) {
    // The page's entrance motion fades sections in; the proof shot waits for it to settle.
    await visitor.emulateMedia({ reducedMotion: "reduce" });
    await visitor.waitForTimeout(1500);
    await visitor.screenshot({ path: `${shots}/dig-thanks-unlocked-390.png`, fullPage: true });
  }
  await visitor.route("https://drive.example.test/**", (route) => route.fulfill({ status: 200, body: "ok" }));
  const [opened] = await Promise.all([visitor.waitForEvent("popup"), visitor.getByRole("link", { name: "Buka / Akses Produk Sekarang ↗" }).click()]);
  await opened.close();
  await expect.poll(async () => (await status()).digital_access?.accessed_at, { timeout: 15_000 }).toBeTruthy();

  // 8. The seller sees it: Digital, opened by the buyer, a WhatsApp hand-off, no courier panel.
  const orderNumber = paid.order_number as string;
  await page.goto(`${STORE}/admin/orders/${encodeURIComponent(orderNumber)}`);
  await expect(page.locator("[data-digital-access-panel]")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-digital-accessed=yes]")).toContainText("Sudah dibuka pembeli");
  await expect(page.locator("[data-send-digital-access]")).toHaveAttribute("href", /^https:\/\/wa\.me\/62\d+\?text=/);
  await expect(page.getByText("Riwayat penerima (RTS)")).toHaveCount(0);

  // 8b. One form for a digital product (owner, 2026-11-23): the landing editor
  // locks it and the Embed dialog offers no mode; the pasted frame is the digital checkout.
  await page.goto(`${STORE}/admin/landing-pages/new`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.getByRole("combobox").filter({ hasText: /Pilih produk/ }).click();
  await page.getByRole("option", { name: /E-book Resep Nusantara/ }).first().click();
  await page.getByRole("button", { name: /Form COD|Form checkout/ }).click();
  await expect(page.locator("[data-form-lock=digital]")).toContainText("Form digital (terkunci)");
  await expect(page.getByRole("combobox", { name: "Jenis form" })).toHaveCount(0);
  await page.goto(`${STORE}/admin/products`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.locator('button[aria-label="Aksi produk E-book Resep Nusantara"]:visible').first().click();
  await page.getByRole("menuitem", { name: "Embed checkout form" }).click();
  const embedDialog = page.getByRole("dialog");
  const snippet = embedDialog.getByLabel("Snippet widget");
  await expect(snippet).not.toHaveValue("", { timeout: 15_000 });
  await expect(embedDialog.locator("[data-form-lock=digital]")).toContainText("Form digital (terkunci)");
  await expect(embedDialog.getByRole("radiogroup", { name: "Mode form" })).toHaveCount(0);
  const frameSrc = (await snippet.inputValue()).match(/<iframe[^>]+src="([^"]+)"/)![1].replace(/&amp;/g, "&");
  expect(await (await page.request.get(frameSrc)).text(), "the pasted frame is the digital checkout").toContain('data-resolved-mode="digital"');
  await embedDialog.screenshot({ path: "test-results/embed-dialog-digital.png" });
  await page.keyboard.press("Escape");

  // 9. Refunded: the access closes again.
  const refunded = await adminFetch(page, `/api/admin/orders/${encodeURIComponent(orderNumber)}`, "PATCH", { payment_status: "refunded", shipping_status: "cancelled" });
  expect(refunded.status, JSON.stringify(refunded.json)).toBe(200);
  expect((await status()).digital_access, "refund revokes the link").toBeNull();

  // 10. Paket 1: a price edit reaches the next anonymous visitor at once.
  const pageUrl = `${STORE}/produk/${PRODUCT_SLUG}`;
  await visitor.goto(pageUrl);
  const second = await visitor.goto(pageUrl);
  expect(second!.headers()["x-edge-cache"], "the page is edge-cached").toBe("HIT");
  const list = await adminFetch(page, "/api/admin/products", "GET");
  const product = (list.json.data.products ?? list.json.data).find((row: { slug: string }) => row.slug === PRODUCT_SLUG);
  const edited = await adminFetch(page, "/api/admin/products", "PATCH", {
    ...product,
    variants: product.variants.map((variant: Record<string, unknown>) => ({ ...variant, price: 59000 })),
  });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const fresh = await visitor.goto(pageUrl);
  expect(fresh!.headers()["x-edge-cache"], "the next visitor misses the old copy").toBe("MISS");
  expect(await fresh!.text()).toContain("59.000");
  await anonymous.close();
});
