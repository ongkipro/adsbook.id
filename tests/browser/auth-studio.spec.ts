// AUTH-MINIMALIST-STEP-UX-SPEC (2026-11-19) in a real browser, local only:
// /masuk and every step of /daftar fit one screen at 1440×900, 1366×768 and
// 390×844 without a pixel of scrolling; no site header and no footer, the
// wordmark and home link at the top of the studio panel (or above the card on a
// phone), the legal line still reachable; the panel follows the choices.
import { expect, test, type Page } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

const shots = process.env.AUTH2_SHOT_DIR;
const VIEWPORTS = [[1440, 900], [1366, 768], [390, 844]] as const;

/** The step's 200 ms entry animation finished (the panel's endless float aside), for a screenshot of the resting state. */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
  );

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
    await expect(panel.getByRole("link", { name: "adsbook.id, ke beranda" })).toHaveAttribute("href", "/");
    const homeLink = panel.getByRole("link", { name: "← Beranda" });
    if (new URL(page.url()).pathname === "/daftar") await expect(homeLink).toHaveCount(0);
    else await expect(homeLink).toHaveAttribute("href", "/");
    await expect(page.locator(".mobile-bar")).toBeHidden();
  } else {
    await expect(page.locator(".studio-panel")).toBeHidden();
    // On a phone the wordmark is the way home; no second "Beranda" text or link.
    await expect(page.locator(".mobile-bar img")).toBeVisible();
    await expect(page.getByRole("link", { name: "adsbook.id, ke beranda" })).toHaveAttribute("href", "/");
    await expect(page.getByText("Beranda", { exact: false }).locator("visible=true")).toHaveCount(0);
  }
}

test("zero scroll: /masuk and every step of /daftar fit one screen at 1440, 1366 and 390", async ({ page }) => {
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto(`${PLATFORM}/masuk`);
    await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Masuk ke Toko");
    await chrome(page, width);
    await noScroll(page, `/masuk ${width}`);
    if (width === 390) {
      for (const id of ["loginIdentifier", "loginPassword"]) {
        await expect(page.locator(`#${id}`)).toHaveCSS("font-size", "16px");
      }
    }
    if (shots && width !== 1366) await page.screenshot({ path: `${shots}/auth2-masuk-${width}.png` });

    await page.goto(`${PLATFORM}/daftar`);
    await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
    await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Buat Toko Baru");
    await chrome(page, width);
    await expect(page.locator('input[name="catalog_mode"]')).toHaveCount(2);
    await expect(page.locator(".catalog-hint")).toContainText("Satu toko bisa keduanya");
    if (width === 390) {
      // Hidden wizard fields still have computed styles.
      for (const id of ["storeName", "slug", "email", "whatsapp", "password"]) {
        await expect(page.locator(`#${id}`)).toHaveCSS("font-size", "16px");
      }
      const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
      expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
    }
    await page.getByLabel("Alamat toko", { exact: true }).fill("herbal-nusantara");
    await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
    await expect(page.locator("#stepNow")).toHaveText("1");
    await noScroll(page, `/daftar step 1 ${width}`);
    if (shots && width !== 1366) await page.screenshot({ path: `${shots}/auth2-daftar-s1-${width}.png` });

    await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
    await expect(page.locator("#stepNow")).toHaveText("2");
    await expect(page.getByLabel("Nama toko")).toBeFocused();
    await noScroll(page, `/daftar step 2 ${width}`);
    if (shots && width !== 1366) {
      await settled(page);
      await page.screenshot({ path: `${shots}/auth2-daftar-s2-${width}.png` });
    }

    await page.getByLabel("Nama toko").fill("Herbal Nusantara");
    await page.getByLabel("Email", { exact: true }).fill("owner@herbal.local.test");
    await page.keyboard.press("Enter");
    await expect(page.locator("#stepNow")).toHaveText("3", { timeout: 5_000 });
    await page.getByLabel("Password", { exact: true }).fill("password-aman-123");
    await expect(page.locator("#ruleLength")).toHaveAttribute("data-ok", "true");
    await expect(page.locator("#ruleDiff")).toHaveAttribute("data-ok", "true");
    await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "ok");
    await noScroll(page, `/daftar step 3 ${width}`);
    if (shots && width !== 1366) {
      await settled(page);
      await page.screenshot({ path: `${shots}/auth2-daftar-s3-${width}.png` });
    }

    // Back to step 2 and 1; nothing typed is lost.
    await page.getByRole("button", { name: "← Kembali" }).click();
    await expect(page.locator("#stepNow")).toHaveText("2");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("owner@herbal.local.test");
    await expect(page.getByLabel("Nama toko")).toHaveValue("Herbal Nusantara");
    await page.getByRole("button", { name: "← Kembali" }).click();
    await expect(page.locator("#stepNow")).toHaveText("1");
    await expect(page.getByLabel("Alamat toko", { exact: true }), "the name never rewrote the address").toHaveValue("herbal-nusantara");
    await expect(page.getByRole("button", { name: "← Kembali" })).toBeHidden();
  }
});

test("the studio panel follows the choices: the address as typed, physical or digital points and next steps", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${PLATFORM}/daftar`);
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
  const panel = page.locator(".studio-panel");
  await expect(panel.locator("#panelStoreUrl")).toHaveText("nama-toko.localhost");
  await page.getByLabel("Alamat toko", { exact: true }).fill("kelas-desain");
  await expect(panel.locator("#panelStoreUrl")).toHaveText("kelas-desain.localhost");
  await expect(panel.getByText("COD, ongkir per kecamatan, dan kontrol RTS")).toBeVisible();
  await expect(panel.locator('[data-next-steps="physical"]')).toBeVisible();
  await page.getByRole("radio", { name: /Produk Digital/ }).check();
  await expect(panel.getByText("Akses digital terbuka otomatis saat lunas")).toBeVisible();
  await expect(panel.getByText("COD, ongkir per kecamatan, dan kontrol RTS")).toBeHidden();
  await expect(panel.locator('[data-next-steps="digital"]')).toBeVisible();
  await expect(panel.locator('[data-next-steps="physical"]')).toBeHidden();
  await page.getByLabel("Alamat toko", { exact: true }).fill("kelas-desain-id");
  await expect(panel.locator("#panelStoreUrl")).toHaveText("kelas-desain-id.localhost");
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
});

test("step 1 is the catalog and the address: one plain field with a fixed suffix, no second copy of the address; long and refused addresses on a phone", async ({ page }) => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    for (const catalog of ["physical", "digital"] as const) {
      await page.goto(`${PLATFORM}/daftar`);
      await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
      if (catalog === "digital") await page.getByRole("radio", { name: /Produk Digital/ }).check();
      const step1 = page.locator('[data-step-panel="1"]');
      // Only the catalog and the address: no name, no badge, no edit toggle, no placeholder address.
      await expect(step1.getByLabel("Nama toko")).toHaveCount(0);
      await expect(step1.getByLabel("Alamat toko", { exact: true })).toBeVisible();
      await expect(step1.locator(".slug-suffix")).toHaveText(".localhost");
      await expect(step1.getByRole("button", { name: /^(Ubah|Selesai)$/ })).toHaveCount(0);
      await expect(page.locator("#slugHint"), "no filler before an address (the line is kept, empty)").toHaveText("");
      await expect(step1).not.toContainText("nama-toko");
      await step1.getByLabel("Alamat toko", { exact: true }).fill("herbal-nusantara");
      await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
      await expect(step1, "the address appears once, in its field").not.toContainText("herbal-nusantara.localhost");
      await noScroll(page, `/daftar step 1 ${catalog} ${width}`);
      if (shots && catalog === "physical") await page.screenshot({ path: `${shots}/auth4-daftar-s1-${width}.png` });
      // Keyboard: Enter moves on, Shift+Tab reaches Back, and the address is kept.
      await page.keyboard.press("Enter");
      await expect(page.locator("#stepNow")).toHaveText("2");
      await expect(page.getByLabel("Nama toko")).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByRole("button", { name: "← Kembali" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#stepNow")).toHaveText("1");
      await expect(page.getByLabel("Alamat toko", { exact: true })).toHaveValue("herbal-nusantara");
      await expect(page.getByRole("radio", { name: catalog === "digital" ? /Produk Digital/ : /Produk Fisik/ })).toBeChecked();
    }

    // A long address wraps nowhere sideways: the field scrolls its own text.
    await page.getByLabel("Alamat toko", { exact: true }).fill("toko-herbal-nusantara-sejahtera");
    await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
    const card = await page.locator(".auth-card").boundingBox();
    const box = await page.locator("#slugBox").boundingBox();
    expect(box!.x + box!.width, "the field stays inside the card").toBeLessThanOrEqual(card!.x + card!.width);
    await noScroll(page, `/daftar long address ${width}`);
    if (shots) await page.screenshot({ path: `${shots}/auth4-daftar-long-${width}.png` });

    // A refused address: the reason beside the field and free alternatives; nothing sideways.
    await page.getByLabel("Alamat toko", { exact: true }).fill("admin");
    await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini tidak tersedia.");
    await expect(page.locator(".sug-chip").first()).toBeVisible();
    await expect(page.locator(".sug-label")).toHaveCSS("font-size", "12.48px");
    await expect(page.getByLabel("Alamat toko", { exact: true })).toHaveCSS("font-family", /monospace/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/auth4-daftar-refused-${width}.png` });
  }
});
