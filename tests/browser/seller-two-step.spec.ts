// T-57 / PR-35 in a real browser against the real local Worker: a seller turns two-step
// verification on in Profile (password, QR secret, proven code, backup codes), then both
// sign-in doors (the store's /hello and adsbook.id/masuk) ask for the code on a separate
// step after the password, and open nothing before it. Also the /hello "Lupa password"
// link. Its own store, so the shared fixtures never get a second factor.
import { expect, test, type Page } from "@playwright/test";
import { totpCode } from "../../src/platform/admin/totp.ts";
import { origin, PLATFORM, signUpThroughWizard } from "./tenants.ts";

const SLUG = "toko-dua-langkah";
const EMAIL = "owner@toko-dua-langkah.local.test";
const PASSWORD = "password-dua-langkah-1";
const step = () => Math.floor(Date.now() / 30_000);

async function passwordAtHello(page: Page) {
  await page.goto(`${origin(SLUG)}/hello`);
  await page.getByLabel("Email atau username").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk" }).click();
}

test("two-step: enrolled in Profile, then /hello and /masuk ask for the code on their own step", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.71" });
  await page.goto(`${PLATFORM}/daftar`);
  await signUpThroughWizard(page, { storeName: "Toko Dua Langkah", slug: SLUG, email: EMAIL, password: PASSWORD });
  await page.waitForURL(`${origin(SLUG)}/admin/setup?welcome=1`, { timeout: 60_000 });

  // Enrollment, on a phone width first.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin(SLUG)}/admin/profile`);
  const section = page.locator("#twoStep");
  await expect(section.locator("#twoStepBadge")).toHaveText("Belum aktif");
  await section.locator("#twoStepBeginPassword").fill("password-salah-sekali");
  await section.getByRole("button", { name: "Aktifkan" }).click();
  await expect(section.locator("#twoStepMessage")).toHaveText("Password saat ini salah.");
  await section.locator("#twoStepBeginPassword").fill(PASSWORD);
  await section.getByRole("button", { name: "Aktifkan" }).click();
  await expect(section.locator("#twoStepQr")).toBeVisible();
  const secret = (await section.locator("#twoStepSecret").textContent())!.replace(/\s+/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const box = await section.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/two-step-enroll-390.png", fullPage: true });

  await section.getByLabel("Kode dari aplikasi").fill("000000");
  await section.getByRole("button", { name: "Verifikasi & Aktifkan" }).click();
  await expect(section.locator("#twoStepMessage")).toContainText("Kode dari aplikasi autentikator salah");
  const enrolledAt = step();
  await section.getByLabel("Kode dari aplikasi").fill(await totpCode(secret, enrolledAt));
  await section.getByRole("button", { name: "Verifikasi & Aktifkan" }).click();
  await expect(section.locator("#twoStepCodes")).toBeVisible();
  const backups = await section.locator("#twoStepCodeList li").allTextContents();
  expect(backups).toHaveLength(10);
  await expect(section.locator("#twoStepBadge")).toHaveText("Aktif");

  // The enrollment ended this session too.
  await page.goto(`${origin(SLUG)}/admin/dashboard`);
  await expect(page).toHaveURL(`${origin(SLUG)}/hello`);

  // /hello: the password, then a separate step; no session cookie before the code.
  await page.setViewportSize({ width: 1280, height: 800 });
  await passwordAtHello(page);
  await expect(page.getByLabel("Kode verifikasi")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  expect((await page.context().cookies()).some((cookie) => cookie.name === "__Host-adsbook_session")).toBe(false);
  await page.screenshot({ path: "test-results/two-step-hello-1280.png" });
  await page.getByLabel("Kode verifikasi").fill("000000");
  await page.getByRole("button", { name: "Verifikasi & Masuk" }).click();
  await expect(page.locator("#loginError")).toContainText("Kode verifikasi salah");
  await expect(page.getByLabel("Kode verifikasi")).toBeVisible();
  await page.goto(`${origin(SLUG)}/admin/dashboard`);
  await expect(page).toHaveURL(`${origin(SLUG)}/hello`);
  await passwordAtHello(page);
  await page.getByLabel("Kode verifikasi").fill(await totpCode(secret, enrolledAt + 1));
  await page.getByRole("button", { name: "Verifikasi & Masuk" }).click();
  await page.waitForURL(`${origin(SLUG)}/admin/dashboard`);
  await page.context().clearCookies();

  // adsbook.id/masuk: the same, on a phone; a backup code works once.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${PLATFORM}/masuk`);
  await page.getByLabel("Email atau username").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk ke Dashboard →" }).click();
  await expect(page.getByLabel("Kode verifikasi")).toBeVisible();
  await expect(page.locator("#loginForm")).toBeHidden();
  await page.screenshot({ path: "test-results/two-step-masuk-390.png" });
  await page.getByLabel("Kode verifikasi").fill("000000");
  await page.getByRole("button", { name: "Verifikasi & Masuk →" }).click();
  await expect(page.locator("#loginError")).toContainText("Kode verifikasi salah");
  await page.getByLabel("Kode verifikasi").fill(backups[0]);
  await page.getByRole("button", { name: "Verifikasi & Masuk →" }).click();
  await page.waitForURL(`${origin(SLUG)}/admin/dashboard`, { timeout: 30_000 });
});

test("/hello links a seller who forgot the password to the platform reset page", async ({ page }) => {
  await page.goto(`${origin("toko-alfa")}/hello`);
  const link = page.getByRole("link", { name: "Buat password baru" });
  await expect(link).toHaveAttribute("href", `${PLATFORM}/lupa-password`);
  await link.click();
  await expect(page.getByRole("heading", { name: "Lupa password" })).toBeVisible();
});
