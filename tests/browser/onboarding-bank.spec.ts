// ONBOARDING-BANK-WAREHOUSE-SPEC (2026-11-19) in a real browser, local only:
// a new physical store owes a bank account (or AutoLaris) on top of its
// warehouse and Mengantar key, because COD skips 15 provinces by default; the
// product form names what is still owed without blocking the save; the
// payments page puts the bank first and AutoLaris as optional; the store's
// public address says where it shows and that it is not the pickup point.
import { expect, test, type Page } from "@playwright/test";
import { origin, PLATFORM } from "./tenants.ts";

const SLUG = "toko-rekening-uji";
const STORE = origin(SLUG);
const OWNER = { email: "owner@toko-rekening-uji.local.test", password: "password-rekening-123" };
const shots = process.env.ONB_SHOT_DIR;

async function adminFetch(page: Page, path: string, method: string, body?: unknown) {
  return page.evaluate(async ([path, method, body]) => {
    const response = await fetch(path as string, { method: method as string, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  }, [path, method, body] as const);
}

const hydrated = (page: Page) =>
  page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

test("physical store: a bank account is a required step, the product form guides, the payments page ranks bank before AutoLaris", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.91" });
  await page.setViewportSize({ width: 1366, height: 900 });

  await page.goto(`${PLATFORM}/daftar`);
  await page.getByLabel("Nama toko").fill("Toko Rekening Uji");
  await page.getByLabel("Alamat toko", { exact: true }).fill(SLUG);
  await expect(page.locator("#slugHint")).toContainText("tersedia.", { timeout: 15_000 });
  await page.getByLabel("Email", { exact: true }).fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await expect(page.locator('[data-next-steps="physical"]')).toContainText("rekening bank untuk pembeli di provinsi non-COD");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
  await page.waitForURL(`${STORE}/admin/setup?welcome=1`, { timeout: 60_000 });

  // Setup: the payment step is required and open (COD skips 15 provinces by default).
  const payment = page.locator("li", { hasText: "Tambahkan rekening bank (atau AutoLaris QRIS/VA)" }).first();
  await expect(payment).toBeVisible();
  await expect(payment).toContainText("Wajib agar pembeli dari provinsi non-COD tetap bisa membayar via transfer bank");
  await expect(page.getByText("Isi alamat usaha (tampil publik)")).toBeVisible();
  if (shots) {
    await payment.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/onb-setup-1366.png` });
  }

  // The product form: a calm guide above, the save button free.
  await page.goto(`${STORE}/admin/products/new`);
  await hydrated(page);
  const guide = page.locator("[data-product-setup-guide]");
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("Langkah setelah simpan produk");
  for (const [step, href] of [["warehouse", "/admin/settings/warehouse"], ["mengantar", "/admin/profile"], ["payment", "/admin/payments"]] as const) {
    await expect(guide.locator(`[data-guide-step="${step}"] a`)).toHaveAttribute("href", href);
  }
  await expect(page.getByRole("button", { name: /Simpan produk/i }).first()).toBeEnabled();
  if (shots) await page.screenshot({ path: `${shots}/onb-product-guide-1366.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await hydrated(page);
  await expect(guide).toBeVisible();
  const box = await guide.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390, "the guide fits a phone").toBeTruthy();
  if (shots) await page.screenshot({ path: `${shots}/onb-product-guide-390.png`, fullPage: false });
  await page.setViewportSize({ width: 1366, height: 900 });

  // Payments: bank first ("siap pakai hari ini"), AutoLaris after it, marked optional.
  await page.goto(`${STORE}/admin/payments`);
  await hydrated(page);
  const bankRow = page.getByRole("heading", { name: /Transfer Bank Manual/ });
  const autolarisRow = page.getByRole("heading", { name: /AutoLaris Payment Gateway/ });
  await expect(bankRow).toBeVisible();
  await expect(autolarisRow).toContainText("Opsional");
  const [bankY, autolarisY] = [(await bankRow.boundingBox())!.y, (await autolarisRow.boundingBox())!.y];
  expect(bankY, "the bank comes before AutoLaris").toBeLessThan(autolarisY);
  await expect(page.getByText("Rekening aktif otomatis melayani pembeli dari provinsi yang dikecualikan dari COD")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/onb-payments-1366.png` });

  // One bank account: the payment step is done and the guide stops naming it.
  const created = await adminFetch(page, "/api/admin/seller-bank-accounts", "POST", { bank_code: "BCA", account_holder: "Toko Rekening Uji", account_number: "1234567890", is_active: true });
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);
  await page.goto(`${STORE}/admin/setup`);
  await expect(page.locator("li", { hasText: "Tambahkan rekening bank (atau AutoLaris QRIS/VA)" }).first()).toContainText("— selesai");
  await page.goto(`${STORE}/admin/products/new`);
  await hydrated(page);
  await expect(guide.locator('[data-guide-step="payment"]')).toHaveCount(0);
  await expect(guide.locator('[data-guide-step="warehouse"]')).toBeVisible();

  // The public address: where it shows, and that it is not the pickup point.
  await page.goto(`${STORE}/admin/settings/store`);
  const hint = page.locator("[data-business-address-hint]");
  await expect(hint).toContainText("Kontak & Kebijakan Privasi");
  await expect(hint.locator('a[href="/admin/settings/warehouse"]')).toBeVisible();
  await hint.scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: `${shots}/onb-store-address-1366.png`, fullPage: false });
});
