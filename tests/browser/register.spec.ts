import { expect, test } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

/**
 * UX-1 through the three-step wizard (AUTH-MINIMALIST-STEP-UX-SPEC §4): step 1
 * refuses an empty name, a taken address opens the editor with free
 * alternatives, the chosen plan survives the marketing rewrite, and the
 * handoff lands the new owner on that plan in /admin/billing.
 */
test("signup with a chosen plan suggests a free address and hands off to billing", async ({ page }) => {
  await page.goto(`${PLATFORM}/daftar?paket=12m`);
  await expect(page.locator(".picked-plan")).toContainText("1 Tahun");
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");

  // Step 1 holds until the store has a name.
  await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
  await expect(page.locator("#storeNameError")).toHaveText("Isi nama toko.");
  await expect(page.getByLabel("Nama toko")).toBeFocused();

  // A reserved name: the editor opens on its own with free alternatives.
  await page.getByLabel("Nama toko").fill("Admin");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini tidak tersedia.");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
  await expect(page.locator("#slugError")).toHaveText("Pilih alamat toko yang tersedia.");
  await page.locator(".sug-chip").first().click();
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia");
  const slug = await page.getByLabel("Alamat toko", { exact: true }).inputValue();

  // The chosen address stays when the name changes afterwards.
  await page.getByLabel("Nama toko").fill("Toko Daftar Uji");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toHaveValue(slug);
  await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
  await expect(page.locator(".ctx-chip")).toContainText(slug);
  await page.getByLabel("Email", { exact: true }).fill("bukan-email");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await expect(page.locator("#emailError")).toContainText("Masukkan email yang valid");
  await page.getByLabel("Email", { exact: true }).fill("owner@daftar-uji.local.test");
  await page.getByLabel("Nomor WhatsApp aktif").fill("0812-3456-7890");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await page.getByLabel("Password", { exact: true }).fill("password-aman-123");
  await page.getByRole("checkbox").check();
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
