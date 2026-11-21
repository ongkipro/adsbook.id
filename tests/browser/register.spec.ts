import { expect, test } from "@playwright/test";
import { PLATFORM, requestAndEnterCode } from "./tenants.ts";

/**
 * UX-1 through the four-step wizard (AUTH-MINIMALIST-STEP-UX-SPEC §4, T-58 step 4 = the mailbox code): step 1
 * refuses an empty name, a taken address opens the editor with free
 * alternatives, the chosen plan survives the marketing rewrite, and the
 * handoff lands the new owner on that plan in /admin/billing.
 */
test("signup with a chosen plan: the address first with free alternatives, the name on step 2, then billing", async ({ page }) => {
  await page.goto(`${PLATFORM}/daftar?paket=12m`);
  await expect(page.locator(".picked-plan")).toContainText("1 Tahun");
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
  const address = page.getByLabel("Alamat toko", { exact: true });
  const next = page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" });

  // Step 1 holds until the store has an address.
  await next.click();
  await expect(page.locator("#slugError")).toHaveText("Alamat toko minimal 3 karakter.");
  await expect(address).toBeFocused();

  // A reserved address: the reason beside the field and free alternatives.
  await address.fill("admin");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini tidak tersedia.");
  await next.click();
  await expect(page.locator("#slugError")).toHaveText("Pilih alamat toko yang tersedia.");
  await page.locator(".sug-chip").first().click();
  await expect(address).toBeFocused();
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia");
  const slug = await address.inputValue();
  await next.click();

  // Step 2: the name is checked here, with focus on it.
  await expect(page.locator("#stepNow")).toHaveText("2");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await expect(page.locator("#storeNameError")).toHaveText("Isi nama toko.");
  await expect(page.getByLabel("Nama toko")).toBeFocused();
  await page.getByLabel("Nama toko").fill("Toko Daftar Uji");
  await page.getByLabel("Email", { exact: true }).fill("bukan-email");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await expect(page.locator("#emailError")).toContainText("Masukkan email yang valid");
  await page.getByLabel("Email", { exact: true }).fill("owner@daftar-uji.local.test");
  await page.getByLabel("Nomor WhatsApp aktif").fill("0812-3456-7890");
  // The name never rewrites the address chosen on step 1.
  await page.getByRole("button", { name: "← Kembali" }).click();
  await expect(address).toHaveValue(slug);
  await next.click();
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await page.getByLabel("Password", { exact: true }).fill("password-aman-123");
  await page.getByRole("checkbox").check();
  // T-58: step 3 asks for the mailbox code; the code is read from the local email capture and typed on step 4.
  expect(await requestAndEnterCode(page, "owner@daftar-uji.local.test")).toBe(true);
  await expect(page.locator("#stepNow")).toHaveText("4");
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();

  await page.waitForURL(new RegExp(`^http://${slug}\\.localhost:\\d+/admin/billing\\?cycle=12m$`));
  await expect(page.getByRole("button", { name: "Bayar Rp1.490.000" })).toBeVisible();
});

test("/masuk is the sign-in page; an old /daftar?masuk=1 link lands there", async ({ page }) => {
  await page.goto(`${PLATFORM}/daftar?masuk=1`);
  await expect(page).toHaveURL(`${PLATFORM}/masuk`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Masuk ke dashboard toko");
  await expect(page.locator("#finderDetails")).toHaveCount(0);
});
