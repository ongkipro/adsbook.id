// T-50 (UX-6, ADR-041): the subscription journey in a real browser at 390 and
// 1280 px — a fresh store in Preview Mode, an Option A QRIS invoice paid at the
// AutoLaris stand-in and credited only by the Advice check, the store going
// live, then lapsing past its grace while the owner can still sign in and renew
// by Virtual Account. Local only: workerd, local D1, provider stand-ins.
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { PORT } from "../../playwright.config.ts";
import { origin, owner } from "./tenants.ts";

const PROVIDERS = `http://127.0.0.1:${PORT + 1}`;

function seedPreviewStore(slug: string) {
  const seed = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/dev-seed.ts", `--platform=http://app.localhost:${PORT}`, `--slug=${slug}`, "--store-name=Toko Langganan", "--preview"],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (seed.status !== 0) throw new Error(`seeding ${slug} failed: ${seed.stderr || seed.stdout}`);
}

/** Moves the store past its grace on the local control plane (the clock is the only lever). */
function lapse(slug: string) {
  const result = spawnSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--local", "-c", "dist/server/wrangler.dev-local.json", "--persist-to", ".wrangler/browser-test-state",
      "--command", `UPDATE tenants SET subscription_ends_at = '2026-01-01T00:00:00.000Z', grace_ends_at = '2026-01-03T00:00:00.000Z', cache_version = cache_version + 1 WHERE slug = '${slug}'`],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CF_API_TOKEN: "" } },
  );
  if (result.status !== 0) throw new Error(`lapse failed: ${result.stderr}`);
}

/** Pays the newest unpaid instruction at the stand-in, as a buyer's bank would. */
async function payAtProvider(page: Page, total: number) {
  const held = (await (await page.request.get(`${PROVIDERS}/__dev/autolaris/payments`)).json()) as Array<{ transaction_id: string; paid: boolean; total: number }>;
  const match = held.filter((payment) => !payment.paid && payment.total === total).at(-1);
  expect(match, "the stand-in holds the instruction").toBeTruthy();
  await page.request.post(`${PROVIDERS}/__dev/autolaris/pay?transaction_id=${encodeURIComponent(match!.transaction_id)}`);
}

async function signIn(page: Page, base: string, slug: string) {
  const { username, password } = owner(slug);
  await page.goto(`${base}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(new RegExp(`^${base}/admin`));
}

const totalOf = async (page: Page) => Number((await page.locator("dd").filter({ hasText: /^Rp/ }).last().innerText()).replace(/\D/g, ""));

for (const width of [390, 1280]) {
  test(`T-50 at ${width}px: preview → pay QRIS → live → lapse → owner renews by VA`, async ({ page, browser }) => {
    const slug = `langganan-${width}`;
    seedPreviewStore(slug);
    const base = origin(slug);
    await page.setViewportSize({ width, height: 900 });

    // Preview: the storefront says so, is not indexed, and takes no order.
    const storefront = await page.goto(`${base}/`);
    expect(storefront?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(page.getByText("Mode Preview — Aktifkan langganan di Admin")).toBeVisible();
    const order = await page.request.post(`${base}/api/submit-order`, { headers: { origin: base }, data: {} });
    expect(order.status()).toBe(402);
    expect((await order.json()).code).toBe("SUBSCRIPTION_REQUIRED");

    // The owner sees the banner on every admin page and reaches billing from it.
    await signIn(page, base, slug);
    await expect(page.locator("#billingNotice")).toContainText("Mode Preview.");
    await page.locator("#billingNotice").getByRole("link", { name: "Aktifkan langganan" }).click();
    await expect(page).toHaveURL(`${base}/admin/billing`);
    await expect(page.getByText("Mode Preview", { exact: true })).toBeVisible();
    for (const price of ["Rp149.000", "Rp399.000", "Rp759.000", "Rp1.490.000"]) await expect(page.getByText(price, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Bayar 10 bulan, gratis 2 bulan")).toBeVisible();
    await page.screenshot({ path: `test-results/billing-${width}-preview.png`, fullPage: true });

    // An annual QRIS invoice; the QR and the countdown render.
    await page.getByLabel(/QRIS/).check();
    await page.getByRole("button", { name: "Bayar Rp1.490.000" }).click();
    await expect(page.getByRole("heading", { name: "Selesaikan pembayaran" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Kode QRIS untuk pembayaran langganan" })).toBeVisible();
    await page.screenshot({ path: `test-results/billing-${width}-qris.png`, fullPage: true });
    // Asked before paying: still pending, nothing credited.
    await page.getByRole("button", { name: "Cek Status Pembayaran" }).click();
    await expect(page.getByText("Pembayaran belum masuk.")).toBeVisible();
    await payAtProvider(page, await totalOf(page));
    await page.getByRole("button", { name: "Cek Status Pembayaran" }).click();
    await expect(page.getByText("Pembayaran diterima. Langganan toko aktif.")).toBeVisible();
    await expect(page.getByText("Aktif", { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.locator("#billingNotice")).toHaveCount(0);

    // Live: the storefront banner is gone and it may be indexed again.
    const live = await page.goto(`${base}/`);
    expect(live?.headers()["x-robots-tag"]).toBeUndefined();
    await expect(page.getByText("Mode Preview — Aktifkan langganan di Admin")).toHaveCount(0);

    // Past the grace: orders pause, the owner still signs in and renews by VA.
    lapse(slug);
    const lapsed = await page.request.post(`${base}/api/submit-order`, { headers: { origin: base }, data: {} });
    expect((await lapsed.json()).code).toBe("SUBSCRIPTION_EXPIRED");
    const fresh = await browser.newContext({ viewport: { width, height: 900 } });
    const ownerPage = await fresh.newPage();
    await signIn(ownerPage, base, slug);
    await expect(ownerPage.locator("#billingNotice")).toContainText("Langganan berakhir.");
    await ownerPage.goto(`${base}/admin/billing`);
    await expect(ownerPage.getByText("Berakhir", { exact: true })).toBeVisible();
    await ownerPage.getByText("1 Bulan", { exact: true }).click();
    await ownerPage.getByLabel(/Virtual Account BCA/).check();
    await ownerPage.getByRole("button", { name: "Bayar Rp149.000" }).click();
    await expect(ownerPage.getByText("Nomor Virtual Account")).toBeVisible();
    await expect(ownerPage.getByRole("button", { name: /Salin nomor VA/ })).toBeVisible();
    await ownerPage.screenshot({ path: `test-results/billing-${width}-va.png`, fullPage: true });
    await payAtProvider(ownerPage, await totalOf(ownerPage));
    await ownerPage.getByRole("button", { name: "Cek Status Pembayaran" }).click();
    await expect(ownerPage.getByText("Pembayaran diterima. Langganan toko aktif.")).toBeVisible();
    await ownerPage.reload();
    await expect(ownerPage.getByText("Aktif", { exact: true }).first()).toBeVisible();
    await expect(ownerPage.getByText("Lunas").first()).toBeVisible();
    await ownerPage.screenshot({ path: `test-results/billing-${width}-renewed.png`, fullPage: true });
    await fresh.close();
  });
}
