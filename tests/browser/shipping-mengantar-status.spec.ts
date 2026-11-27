// Pengiriman (2026-11-28): each Mengantar shipment shows Mengantar's own status
// category in a seller's words, with Mengantar's name beside it, and a category
// that needs a look says so. The status comes in through the real webhook route,
// signed the way Mengantar signs it (HMAC-SHA256 of `${x-timestamp}.${body}`).
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);
const SECRET = "whsec-status-label-123456789";

async function signIn(page: Page) {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

async function issueWebhook(page: Page): Promise<string> {
  await page.goto(`${STORE}/admin/profile`);
  await page.locator("#issueMengantarWebhook").click();
  await expect(page.locator("#mengantarWebhookWrap")).toBeVisible({ timeout: 10_000 });
  const url = (await page.locator("#mengantarWebhookUrl").textContent())?.trim() ?? "";
  await page.locator("#mengantarWebhookSecret").fill(SECRET);
  await page.locator("#saveIntegrations").click();
  await expect(page.locator("#saveStatus")).toContainText("berhasil disimpan", { timeout: 10_000 });
  return new URL(url).pathname;
}

async function send(page: Page, path: string, cnoteNo: string, category: string, at: number) {
  const body = JSON.stringify({ cnote_no: cnoteNo, order_id: null, courier: "JNE", status_category: category });
  const timestamp = String(at);
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  const res = await page.request.post(`${STORE}${path}`, {
    headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-signature": signature },
    data: body,
  });
  expect(res.status(), `${category}: ${await res.text()}`).toBeLessThan(300);
}

const ready = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

test("a Mengantar shipment reads Mengantar's own status, and one needing a look is marked", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await signIn(page);
  const path = await issueWebhook(page);

  const shipments = (await (await page.request.get(`${STORE}/api/admin/shipping`)).json()).data.shipments as Array<{ orderNumber: string; cnoteNo: string | null; providerOrderId: string | null }>;
  const seeded = shipments.find((row) => row.cnoteNo && row.providerOrderId);
  expect(seeded, "the dev seed dispatched one Mengantar order").toBeTruthy();

  const table = page.locator('[aria-label="Tabel pengiriman desktop"]');
  const row = table.locator("tr", { hasText: seeded!.orderNumber });
  const status = row.locator("[data-mengantar-status]");
  const now = Date.now();

  // Before any update from the courier.
  await page.goto(`${STORE}/admin/shipping`);
  await ready(page);
  await expect(status).toHaveAttribute("data-mengantar-status", "none");
  await expect(status).toContainText("Belum ada update dari kurir");

  // PENDING PICKUP: waiting, Mengantar's name beside the seller's words.
  await send(page, path, seeded!.cnoteNo!, "PENDING PICKUP", now - 60_000);
  await page.reload();
  await ready(page);
  await expect(status).toHaveAttribute("data-mengantar-status", "PENDING PICKUP");
  await expect(status).toContainText("Menunggu pickup");
  await expect(status).toContainText("PENDING PICKUP");
  await expect(status).not.toContainText("perlu cek");

  // UNDELIVERED: needs a look, and says so.
  await send(page, path, seeded!.cnoteNo!, "UNDELIVERED", now);
  await page.reload();
  await ready(page);
  await expect(status).toHaveAttribute("data-mengantar-status", "UNDELIVERED");
  await expect(status).toContainText("Gagal kirim");
  await expect(status).toContainText("perlu cek");

  // The same words on a phone card.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await ready(page);
  const card = page.locator("article", { hasText: seeded!.orderNumber }).locator("[data-mengantar-status]");
  await expect(card).toContainText("Gagal kirim");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  expect(errors).toEqual([]);
  await context.close();
});
