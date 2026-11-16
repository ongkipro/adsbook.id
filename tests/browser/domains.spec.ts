// T-25/T-43/UX-3 (re-checked 2026-11-16 for Paduka): a seller connects their
// own domain and later replaces it, in a real browser against the local
// platform. The Cloudflare for SaaS API is the dev-providers stand-in; the
// "seller pointed DNS and the certificate issued" step is its activate hook.
// Nothing here reaches Cloudflare.
import { expect, test, type Page } from "@playwright/test";
import { PORT } from "../../playwright.config.ts";
import { origin, owner } from "./tenants.ts";

const PROVIDERS = `http://127.0.0.1:${PORT + 1}`;
const STORE = origin("toko-alfa");

async function signIn(page: Page) {
  const { username, password } = owner("toko-alfa");
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

async function activate(page: Page, hostname: string) {
  const response = await page.request.post(`${PROVIDERS}/__dev/cloudflare/activate?hostname=${encodeURIComponent(hostname)}`);
  expect(response.status(), `stand-in activates ${hostname}`).toBe(200);
}

test("seller connects a root domain (CNAME to cname.adsbook.my.id), it activates, then replaces it with another", async ({ page }) => {
  await signIn(page);
  await page.goto(`${STORE}/admin/settings/domains`);

  // 1. Claim tokoalfa-uji.com as the main domain (root + www).
  await page.getByLabel("Domain", { exact: true }).fill("tokoalfa-uji.com");
  await page.getByRole("button", { name: "Tambah domain" }).click();
  const list = page.getByRole("list", { name: "Domain toko" });
  await expect(list).toContainText("tokoalfa-uji.com");
  await expect(list).toContainText("www.tokoalfa-uji.com");
  // The seller is told exactly what to put in DNS: a CNAME to the platform target, never an IP.
  await expect(list).toContainText("@ CNAME cname.adsbook.my.id");
  await expect(list).toContainText("www CNAME cname.adsbook.my.id");
  await expect(list).toContainText("Jangan pakai A record");
  await page.screenshot({ path: "test-results/domains-pending.png", fullPage: true });

  // 2. DNS pointed, certificate issued (stand-in), "Cek lagi" picks it up.
  await activate(page, "tokoalfa-uji.com");
  await activate(page, "www.tokoalfa-uji.com");
  // Each re-check re-renders the list, so click the first remaining one until none is left.
  for (let round = 0; round < 4 && (await page.getByRole("button", { name: "Cek lagi" }).count()) > 0; round += 1) {
    await page.getByRole("button", { name: "Cek lagi" }).first().click();
    await expect(page.getByRole("button", { name: "Memeriksa…" })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Cek lagi" })).toHaveCount(0);
  await expect(list.locator("li", { hasText: /^tokoalfa-uji\.com/ }).first()).toContainText("Aktif");
  await page.screenshot({ path: "test-results/domains-active.png", fullPage: true });

  // 3. Replace it with a different domain: one store = one own domain (ADR-041).
  await page.getByLabel("Domain", { exact: true }).fill("tokoalfa-baru.com");
  await page.locator("form").getByRole("button", { name: "Ganti domain" }).click();
  // The replacement is confirmed in a dialog (useConfirm) naming both domains.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Ganti tokoalfa-uji.com dengan tokoalfa-baru.com?");
  await dialog.getByRole("button", { name: "Ganti domain" }).click();
  await expect(list).toContainText("tokoalfa-baru.com");
  await expect(list).not.toContainText("tokoalfa-uji.com");
  await expect(list).toContainText("@ CNAME cname.adsbook.my.id");
  await page.screenshot({ path: "test-results/domains-replaced.png", fullPage: true });

  // A second, different domain is refused while one is held (1 store = 1 own domain).
  const second = await page.request.post(`${STORE}/api/admin/domains`, {
    headers: { "content-type": "application/json", origin: STORE, "sec-fetch-site": "same-origin" },
    data: { host: "domainketiga.com", mode: "root" },
  });
  expect(second.status()).toBeGreaterThanOrEqual(400);
});
