import { expect, test } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const SLUG = "toko-alfa";
const STORE = origin(SLUG);

test("Audit B: dashboard carries period to shipping/leads/analitik, shipping reads period from URL, data limits are visible", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const { username, password } = owner(SLUG);
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);

  // Open dashboard on a specific period (`last_month`) and verify outgoing links carry it.
  await page.goto(`${STORE}/admin/dashboard?preset=last_month`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.locator('a[href="/admin/shipping?date_filter=last_month"]')).toBeVisible();
  await expect(page.locator('a[href="/admin/orders/abandoned?date_filter=last_month"]')).toBeVisible();
  await expect(page.locator('a[href="/admin/analytics/products?date_filter=last_month"]')).toBeVisible();
  await expect(page.locator('a[href="/admin/analytics/landing?date_filter=last_month"]')).toBeVisible();
  await expect(page.getByText(/lead maks\. 14 hari/)).toBeVisible();
  await expect(page.getByText(/simpan 14 hari/)).toBeVisible();

  // Clicking into Shipping opens with that period applied from URL.
  const shippingApi = page.waitForRequest((req) =>
    req.url().includes("/api/admin/shipping") && req.url().includes("date_filter=last_month"),
  );
  await page.locator('a[href="/admin/shipping?date_filter=last_month"]').click();
  await page.waitForURL(`${STORE}/admin/shipping?date_filter=last_month`);
  await shippingApi;
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.getByRole("button", { name: /Bulan lalu/ })).toBeVisible();

  // Opening Analitik Ringkasan displays both 14-day lead and 30-day Meta Purchase retention limits.
  await page.goto(`${STORE}/admin/analytics?date_filter=last_month`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await expect(page.getByText(/lead tertinggal disimpan 14 hari/i)).toBeVisible();
  await expect(page.getByText(/Purchase ke Meta disimpan 30 hari/i)).toBeVisible();

  expect(errors, "no console or page errors").toEqual([]);
});
