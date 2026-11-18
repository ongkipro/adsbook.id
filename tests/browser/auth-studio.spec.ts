// AUTH-MINIMALIST-STEP-UX-SPEC (2026-11-19) in a real browser, local only:
// /masuk and every step of /daftar fit one screen at 1440×900, 1366×768 and
// 390×844 without a pixel of scrolling; no site header and no footer, the
// wordmark and home link at the top of the studio panel (or above the card on a
// phone), the legal line still reachable; the panel follows the choices.
import { expect, test, type Page } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

const shots = process.env.AUTH2_SHOT_DIR;
const VIEWPORTS = [[1440, 900], [1366, 768], [390, 844]] as const;

async function noScroll(page: Page, label: string) {
  const size = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    width: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(size.height, `${label}: no vertical scroll`).toBeLessThanOrEqual(size.viewport);
  expect(size.width, `${label}: no horizontal scroll`).toBeLessThanOrEqual(size.viewportWidth);
}

async function chrome(page: Page, width: number) {
  await expect(page.locator("footer"), "no footer").toHaveCount(0);
  await expect(page.locator("[data-site-header], #btn-user-auth, #btn-mobile-menu"), "no site header").toHaveCount(0);
  const visibleLegal = page.locator(".legal:visible");
  await expect(visibleLegal).toHaveCount(1);
  await expect(visibleLegal.getByRole("link", { name: "Syarat Layanan" })).toHaveAttribute("href", "/syarat");
  await expect(visibleLegal.getByRole("link", { name: "Kebijakan Privasi" })).toHaveAttribute("href", "/privasi");
  if (width >= 960) {
    // The wordmark sits at the top of the studio panel, the home link beside it.
    const panel = page.locator(".studio-panel");
    await expect(panel).toBeVisible();
    const top = await panel.locator(".panel-top").boundingBox();
    const mark = await panel.locator(".panel-top img").boundingBox();
    expect(mark!.y - top!.y).toBeLessThan(20);
    await expect(panel.getByRole("link", { name: "← Beranda" })).toHaveAttribute("href", "/");
    await expect(page.locator(".mobile-bar")).toBeHidden();
  } else {
    await expect(page.locator(".studio-panel")).toBeHidden();
    await expect(page.locator(".mobile-bar img")).toBeVisible();
    await expect(page.locator(".mobile-bar").getByRole("link", { name: "← Beranda" })).toBeVisible();
  }
}

test("zero scroll: /masuk and every step of /daftar fit one screen at 1440, 1366 and 390", async ({ page }) => {
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto(`${PLATFORM}/masuk`);
    await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Masuk ke Toko");
    await chrome(page, width);
    await noScroll(page, `/masuk ${width}`);
    if (shots && width !== 1366) await page.screenshot({ path: `${shots}/auth2-masuk-${width}.png` });

    await page.goto(`${PLATFORM}/daftar`);
    await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
    await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Buat Toko Baru");
    await chrome(page, width);
    await expect(page.locator('input[name="catalog_mode"]')).toHaveCount(2);
    await expect(page.locator(".catalog-hint")).toContainText("Satu toko bisa keduanya");
    await page.getByLabel("Nama toko").fill("Herbal Nusantara");
    await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
    await expect(page.locator("#slugPill")).toContainText("herbal-nusantara.localhost");
    await expect(page.locator("#stepNow")).toHaveText("1");
    await noScroll(page, `/daftar step 1 ${width}`);
    if (shots && width !== 1366) await page.screenshot({ path: `${shots}/auth2-daftar-s1-${width}.png` });

    await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
    await expect(page.locator("#stepNow")).toHaveText("2");
    await expect(page.locator(".ctx-chip")).toHaveText("herbal-nusantara.localhost · Produk Fisik");
    await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
    await noScroll(page, `/daftar step 2 ${width}`);
    if (shots && width === 1440) await page.screenshot({ path: `${shots}/auth2-daftar-s2-${width}.png` });

    await page.getByLabel("Email", { exact: true }).fill("owner@herbal.local.test");
    await page.keyboard.press("Enter");
    await expect(page.locator("#stepNow")).toHaveText("3", { timeout: 5_000 });
    await page.getByLabel("Password", { exact: true }).fill("password-aman-123");
    await expect(page.locator("#ruleLength")).toHaveAttribute("data-ok", "true");
    await expect(page.locator("#ruleDiff")).toHaveAttribute("data-ok", "true");
    await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "ok");
    await noScroll(page, `/daftar step 3 ${width}`);
    if (shots && width === 1440) await page.screenshot({ path: `${shots}/auth2-daftar-s3-${width}.png` });

    // Back to step 2 and 1; nothing typed is lost.
    await page.getByRole("button", { name: "← Kembali" }).click();
    await expect(page.locator("#stepNow")).toHaveText("2");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("owner@herbal.local.test");
    await page.getByRole("button", { name: "← Kembali" }).click();
    await expect(page.locator("#stepNow")).toHaveText("1");
    await expect(page.getByRole("button", { name: "← Kembali" })).toBeHidden();
  }
});

test("the studio panel follows the choices: the address as typed, physical or digital points and next steps", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${PLATFORM}/daftar`);
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
  const panel = page.locator(".studio-panel");
  await expect(panel.locator("#panelStoreUrl")).toHaveText("nama-toko.localhost");
  await page.getByLabel("Nama toko").fill("Kelas Desain");
  await expect(panel.locator("#panelStoreUrl")).toHaveText("kelas-desain.localhost");
  await expect(panel.getByText("COD, ongkir per kecamatan, dan kontrol RTS")).toBeVisible();
  await expect(panel.locator('[data-next-steps="physical"]')).toBeVisible();
  await page.getByRole("radio", { name: /Produk Digital/ }).check();
  await expect(panel.getByText("Akses digital terbuka otomatis saat lunas")).toBeVisible();
  await expect(panel.getByText("COD, ongkir per kecamatan, dan kontrol RTS")).toBeHidden();
  await expect(panel.locator('[data-next-steps="digital"]')).toBeVisible();
  await expect(panel.locator('[data-next-steps="physical"]')).toBeHidden();
  // [Ubah] opens the editor; a typed address leads the pill and the panel.
  await page.getByRole("button", { name: "Ubah" }).click();
  await page.getByLabel("Alamat toko", { exact: true }).fill("kelas-desain-id");
  await expect(page.locator("#slugPillHost")).toHaveText("kelas-desain-id");
  await expect(panel.locator("#panelStoreUrl")).toHaveText("kelas-desain-id.localhost");
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
});
