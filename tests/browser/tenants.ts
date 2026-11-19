import { expect, type Page } from "@playwright/test";
import { PORT } from "../../playwright.config.ts";

/** The two stores the suite signs up; the owner credentials are dev-seed's fixed local ones. */
export const TENANTS = [
  { slug: "toko-alfa", name: "Toko Alfa" },
  { slug: "toko-beta", name: "Toko Beta" },
] as const;

export const origin = (slug: string) => `http://${slug}.localhost:${PORT}`;
export const PLATFORM = `http://app.localhost:${PORT}`;
export const owner = (slug: string) => ({ username: `owner@${slug}.local.test`, password: "dev-local-password-123" });

/**
 * Signup through the three-step wizard on /daftar (AUTH-MINIMALIST-STEP-UX-SPEC §4),
 * from a page already on it. A `slug` that is not the name's own opens the editor.
 * Stops at the click on "Buat Toko Gratis →"; the caller asserts what follows.
 */
export async function signUpThroughWizard(
  page: Page,
  input: { storeName: string; slug?: string; email: string; password: string; whatsapp?: string; catalog?: "physical" | "digital" },
) {
  // Typed before the script runs, a value would miss its input handlers.
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
  if (input.catalog === "digital") await page.getByRole("radio", { name: /Produk Digital/ }).check();
  await page.getByLabel("Nama toko").fill(input.storeName);
  if (input.slug) {
    await expect(page.locator("#slugHint")).not.toHaveText("Memeriksa…", { timeout: 15_000 });
    if ((await page.locator("#slugPillHost").textContent()) !== input.slug) {
      if (await page.locator("#slugEditor").isHidden()) await page.getByRole("button", { name: "Ubah" }).click();
      await page.getByLabel("Alamat toko", { exact: true }).fill(input.slug);
    }
  }
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
  await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
  await page.getByLabel("Email", { exact: true }).fill(input.email);
  if (input.whatsapp) await page.getByLabel("Nomor WhatsApp aktif").fill(input.whatsapp);
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await page.getByLabel("Password", { exact: true }).fill(input.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
}
