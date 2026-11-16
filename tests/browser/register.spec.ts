import { expect, test } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

/**
 * UX-1: the signup page end to end in a real browser — a taken address offers
 * free alternatives, the chosen plan survives the marketing rewrite, and the
 * handoff lands the new owner on that plan in /admin/billing.
 */
test("signup with a chosen plan suggests a free address and hands off to billing", async ({ page }) => {
  await page.goto(`${PLATFORM}/daftar?paket=12m`);
  await expect(page.locator(".picked-plan")).toContainText("1 Tahun");

  await page.getByRole("button", { name: "Buat toko" }).click();
  await expect(page.locator("#errorSummary")).toBeVisible();

  await page.getByLabel("Nama toko").fill("Admin");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini tidak tersedia.");
  await page.locator(".sug-chip").first().click();
  await expect(page.locator("#slugHint")).toContainText("tersedia.");
  const slug = await page.getByLabel("Alamat toko", { exact: true }).inputValue();

  await page.getByLabel("Nama toko").fill("Toko Daftar Uji");
  await page.getByLabel("Email", { exact: true }).fill("owner@daftar-uji.local.test");
  await page.getByLabel("Nomor WhatsApp aktif").fill("0812-3456-7890");
  await page.getByLabel("Password", { exact: true }).fill("password-aman-123");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Buat toko" }).click();

  await page.waitForURL(new RegExp(`^http://${slug}\\.localhost:\\d+/admin/billing\\?cycle=12m$`));
  await expect(page.getByRole("button", { name: "Bayar Rp1.490.000" })).toBeVisible();
});

test("/masuk opens the store finder", async ({ page }) => {
  await page.goto(`${PLATFORM}/masuk`);
  await expect(page).toHaveURL(/\/daftar\?masuk=1$/);
  await expect(page.locator("#finderDetails")).toHaveAttribute("open", "");
});
