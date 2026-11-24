// The admin search palette loads the first time it opens (AdminSearch.tsx,
// lazy) and must still find a page and take the operator there, from the
// keyboard on a desktop and from the search button on a phone.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const STORE = origin("toko-alfa");

async function signIn(page: Page) {
  const { username, password } = owner("toko-alfa");
  await page.goto(`${STORE}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
}

test("admin search at 1366: Ctrl+K opens it, typing filters, Enter opens the page", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const scripts: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(request.url()); });
  await signIn(page);
  expect(scripts.some((url) => /AdminSearch\./.test(url)), "the palette is not downloaded with the page").toBe(false);
  const input = page.getByRole("dialog").getByPlaceholder("Ketik nama halaman atau tugas…");
  // The very first press, the moment the island is marked ready: React subscribes
  // 40-55 ms later, so this press is caught by the layout script and replayed.
  await page.keyboard.press("Control+k");
  await expect(input).toBeFocused({ timeout: 10_000 });
  expect(scripts.some((url) => /AdminSearch\./.test(url)), "it loads on first open").toBe(true);
  await input.fill("produk");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/admin\/products/);
});

test("Ctrl+K pressed before the admin shell is interactive still opens the search, once", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  // A fresh load, the shortcut sent while the page is still loading.
  await page.goto(`${STORE}/admin/orders`, { waitUntil: "commit" });
  await page.waitForSelector("astro-island");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("dialog").getByPlaceholder("Ketik nama halaman atau tugas…");
  await expect(input).toBeVisible({ timeout: 10_000 });
  // A second press closes it, like the shortcut always did.
  await page.keyboard.press("Control+k");
  await expect(input).toHaveCount(0);
});

test("admin search at 390: the button opens a sheet and a tap opens the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: /Cari/ }).first().click();
  const input = page.getByPlaceholder("Ketik nama halaman atau tugas…");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("pesanan");
  await page.getByRole("option").first().click();
  await page.waitForURL(/\/admin\/orders/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
