// Pesanan tertinggal (2026-11-27): the follow-up status is one coloured label
// per lead that is also the control to change it, the queue filters by status
// chips with counts, and opening WhatsApp on a lead not yet contacted marks it
// "Sudah dihubungi" (owner's choice). Checked at a phone and a laptop width.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);

async function signIn(page: Page) {
  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

async function seedLead(page: Page, name: string, phone: string): Promise<string> {
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{ is_active: number | boolean; product_type?: string; variants: Array<{ id: number }> }>;
  const physical = rows.find((row) => (row.is_active === 1 || row.is_active === true) && row.product_type !== "digital")!;
  const res = await page.request.post(`${STORE}/api/record-abandoned-order`, {
    headers: { origin: STORE, "sec-fetch-site": "same-origin", referer: `${STORE}/` },
    data: { customer_name: name, customer_phone: phone, variant_id: String(physical.variants[0].id) },
  });
  const body = await res.json();
  expect(body.success, JSON.stringify(body).slice(0, 200)).toBe(true);
  return String(body.order_number);
}

const ready = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

test("a lead's status is a coloured label that changes it, chips count the queue, WhatsApp marks it contacted", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await signIn(page);
  const stamp = String(Date.now()).slice(-6);
  const name = `Lead Label ${stamp}`;
  const order = await seedLead(page, name, `0812${stamp}91`);

  await page.goto(`${STORE}/admin/orders/abandoned`);
  await ready(page);
  const row = page.getByRole("article", { name });
  await expect(row).toHaveAttribute("data-lead-status", "new");
  const trigger = row.locator("[data-lead-status-trigger]");
  await expect(trigger).toContainText("Belum dihubungi");
  // Each status has its own colour: amber for a lead that still needs contact.
  expect(await trigger.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));

  const chips = page.locator("[data-lead-status-chips]");
  const count = async (label: string) => Number((await chips.getByRole("button", { name: new RegExp(`^${label}`) }).innerText()).match(/(\d+)\s*$/)?.[1] ?? NaN);
  const newBefore = await count("Belum dihubungi");
  const qualifiedBefore = await count("Berminat");

  // The label is the control: pick "Berminat" from its menu, which closes on the pick.
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Berminat", exact: true }).click();
  await expect(page.getByRole("menu"), "the menu closes on a pick, so no second change can race the first").toHaveCount(0);
  await expect(row).toHaveAttribute("data-lead-status", "qualified");
  await expect(trigger).toContainText("Berminat");
  expect(await count("Belum dihubungi")).toBe(newBefore - 1);
  expect(await count("Berminat")).toBe(qualifiedBefore + 1);
  // Who recorded it is on the row, not only in a tooltip.
  await expect(row).toContainText(/Dicatat .* oleh /);

  // A failed save puts the row and the counts back.
  await page.route("**/api/admin/abandoned-orders", (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, error: "Simpan gagal (uji)." }) }) : route.fallback(),
  );
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Tidak berminat", exact: true }).click();
  await expect(page.getByText("Simpan gagal (uji).")).toBeVisible();
  await expect(row).toHaveAttribute("data-lead-status", "qualified");
  expect(await count("Berminat")).toBe(qualifiedBefore + 1);
  await page.unroute("**/api/admin/abandoned-orders");

  // Stored: a reload shows the same status.
  await page.reload();
  await ready(page);
  await expect(page.getByRole("article", { name })).toHaveAttribute("data-lead-status", "qualified");

  // The chip filters the queue to that status.
  await chips.getByRole("button", { name: /^Berminat/ }).click();
  await expect(page.getByRole("article", { name })).toBeVisible();
  await chips.getByRole("button", { name: /^Belum dihubungi/ }).click();
  await expect(page.getByRole("article", { name })).toHaveCount(0);

  // A second lead: opening WhatsApp marks it contacted.
  const second = `Lead WA ${stamp}`;
  await seedLead(page, second, `0813${stamp}92`);
  await chips.getByRole("button", { name: /^Semua/ }).click();
  await page.reload();
  await ready(page);
  const waRow = page.getByRole("article", { name: second });
  await expect(waRow).toHaveAttribute("data-lead-status", "new");
  await context.route("https://wa.me/**", (route) => route.fulfill({ status: 200, body: "ok" }));
  await context.route("https://api.whatsapp.com/**", (route) => route.fulfill({ status: 200, body: "ok" }));
  const [popup] = await Promise.all([page.waitForEvent("popup"), waRow.getByRole("button", { name: "WhatsApp" }).click()]);
  await popup.close();
  await expect(waRow).toHaveAttribute("data-lead-status", "contacted");
  // The notice says what the record means.
  await expect(page.getByRole("status").filter({ hasText: "tidak memastikan pesan terkirim" })).toBeVisible();
  await page.reload();
  await ready(page);
  await expect(page.getByRole("article", { name: second })).toHaveAttribute("data-lead-status", "contacted");

  expect(order).toMatch(/^ABN-/);
  expect(errors).toEqual([]);
  await context.close();
});

test("on a phone the status sits beside the buyer and nothing scrolls sideways", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page);
  const stamp = String(Date.now()).slice(-6);
  const name = `Lead Phone ${stamp}`;
  await seedLead(page, name, `0814${stamp}93`);
  await page.goto(`${STORE}/admin/orders/abandoned`);
  await ready(page);
  const row = page.getByRole("article", { name });
  const buyer = await row.getByText(name, { exact: true }).boundingBox();
  const status = await row.locator("[data-lead-status-trigger]").boundingBox();
  expect(Math.abs(buyer!.y - status!.y), "status on the buyer's line").toBeLessThan(24);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await context.close();
});
