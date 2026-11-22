// "Lupa password" for a store owner, in a real browser against the real local Worker: the link on
// /masuk, the code mailed through the local email capture (no mock, no bypass), the new password,
// the old one refused and the new one signing in through the one door. Its own store, so the
// shared fixtures' owner passwords are never changed.
import { expect, test, type Page } from "@playwright/test";
import { RESET_SUBJECT, readVerificationCode, sentVerificationIds } from "../../scripts/dev-mailbox.ts";
import { EXPLORER, origin, PLATFORM, signUpThroughWizard } from "./tenants.ts";

const SLUG = "toko-lupa-sandi";
const EMAIL = "owner@toko-lupa-sandi.local.test";
const OLD_PASSWORD = "password-lama-123";
const NEW_PASSWORD = "password-baru-456";

async function signInAtMasuk(page: Page, identifier: string, password: string) {
  await page.goto(`${PLATFORM}/masuk`);
  await page.getByLabel("Email atau username").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk ke Dashboard →" }).click();
}

test("the owner resets a forgotten password from /masuk with the mailed code, then signs in with the new one only", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.93" });
  await page.goto(`${PLATFORM}/daftar`);
  await signUpThroughWizard(page, { storeName: "Toko Lupa Sandi", slug: SLUG, email: EMAIL, password: OLD_PASSWORD });
  await page.waitForURL(`${origin(SLUG)}/admin/setup?welcome=1`, { timeout: 60_000 });
  await page.context().clearCookies();

  // /masuk links to the reset page where the signup link used to be (the tab above already opens /daftar).
  await page.goto(`${PLATFORM}/masuk`);
  await expect(page.getByText("Belum punya toko?")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Buat Toko Baru" })).toBeVisible();
  await page.getByRole("link", { name: "Buat password baru →" }).click();
  await expect(page).toHaveURL(`${PLATFORM}/lupa-password`);
  await expect(page.getByRole("heading", { name: "Lupa password" })).toBeVisible();

  const seen = await sentVerificationIds(EXPLORER, EMAIL, RESET_SUBJECT);
  await page.getByLabel("Email pemilik toko").fill(EMAIL);
  await page.getByRole("button", { name: "Kirim kode →" }).click();
  await expect(page.locator("#sentNote")).toContainText("kode 8 digit sudah dikirim");
  const code = await readVerificationCode(EMAIL, { explorer: EXPLORER, ignore: seen, subject: RESET_SUBJECT });

  // A wrong code is refused on the code field and changes nothing.
  await page.getByLabel("Kode dari email").fill(code === "00000000" ? "00000001" : "00000000");
  await page.getByLabel("Password baru").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Simpan password baru →" }).click();
  await expect(page.locator("#resetError")).toContainText("Kode salah atau sudah tidak berlaku");

  await page.getByLabel("Kode dari email").fill(code);
  await page.getByRole("button", { name: "Simpan password baru →" }).click();
  await expect(page.getByText("Password berhasil diganti")).toBeVisible();

  await signInAtMasuk(page, EMAIL, OLD_PASSWORD);
  await expect(page.locator("#loginError")).toHaveText("Email/username atau password belum sesuai.");
  await signInAtMasuk(page, EMAIL, NEW_PASSWORD);
  await page.waitForURL(`${origin(SLUG)}/admin/dashboard`, { timeout: 30_000 });
});

test("an address that owns no store sees the same confirmation and no code mail is sent", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.94" });
  const nobody = "siapa-saja@tidak-ada.local.test";
  const seen = await sentVerificationIds(EXPLORER, nobody, RESET_SUBJECT);
  await page.goto(`${PLATFORM}/lupa-password`);
  await page.getByLabel("Email pemilik toko").fill(nobody);
  await page.getByRole("button", { name: "Kirim kode →" }).click();
  await expect(page.locator("#sentNote")).toContainText("kode 8 digit sudah dikirim");
  await page.waitForTimeout(1500);
  expect((await sentVerificationIds(EXPLORER, nobody, RESET_SUBJECT)).size).toBe(seen.size);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
  test(`/lupa-password fits ${viewport.width}px, is noindex and never cached`, async ({ page, request }) => {
    const head = await request.get(`${PLATFORM}/lupa-password`, { maxRedirects: 0 });
    expect(head.status()).toBe(200);
    expect(head.headers()["x-robots-tag"] ?? "").toContain("noindex");
    expect(head.headers()["cache-control"] ?? "").toContain("no-store");
    await page.setViewportSize(viewport);
    await page.goto(`${PLATFORM}/lupa-password`);
    await expect(page.getByLabel("Email pemilik toko")).toBeVisible();
    await expect(page.getByRole("button", { name: "Kirim kode →" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
