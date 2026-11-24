// The admin top bar's two menus, the account menu and the notification bell,
// at a desktop and a phone width. The account menu did not open at all after
// the Base UI move (2026-11-24): its heading label threw Base UI error #31
// because a GroupLabel needs a Menu.Group. Nothing tested it.
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

for (const width of [1366, 390]) {
  test(`top bar at ${width}: account menu and notifications open and act`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await signIn(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error" && /Base UI error/.test(message.text())) errors.push(message.text()); });

    // Account menu: who is signed in, links, What's new, Keluar.
    await page.getByRole("button", { name: /^Menu akun/ }).click();
    const account = page.getByRole("menu");
    await expect(account.getByRole("menuitem", { name: /Profil & keamanan/ })).toBeVisible();
    await expect(account.getByRole("menuitem", { name: "Keluar" })).toBeVisible();
    await account.getByRole("menuitem", { name: /What's new/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Notifications: the bell opens its panel with a heading and the mute switch.
    await page.getByRole("button", { name: /^Notifikasi/ }).click();
    await expect(page.getByText("Notifikasi", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Bisukan|Bunyikan) notifikasi$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Keluar signs out.
    await page.getByRole("button", { name: /^Menu akun/ }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "Keluar" }).click();
    await page.waitForURL(/\/hello/);
    expect(errors).toEqual([]);
  });
}

test("menus with a heading open: order actions and payment actions", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 860 });
  await signIn(page);
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && /Base UI error/.test(message.text())) errors.push(message.text()); });

  await page.goto(`${STORE}/admin/orders`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.getByRole("button", { name: /Aksi/ }).first().click();
  await expect(page.getByRole("menu").getByText(/^Order /)).toBeVisible();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /Lihat Detail Order/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`${STORE}/admin/payments`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.getByRole("button", { name: "Buka aksi pembayaran" }).click();
  await expect(page.getByRole("menu").getByText("Pembayaran", { exact: true })).toBeVisible();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Buka rekonsiliasi" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Dashboard filters load their list on first click and still filter", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 860 });
  const scripts: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(request.url()); });
  await signIn(page);
  await page.goto(`${STORE}/admin/dashboard`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  const loaded = (name: string) => scripts.some((url) => new RegExp(`/${name}\\.`).test(url));
  expect(["dropdown-menu", "AdminDateRangePanel", "FilterSelectMenu", "AccountMenu", "NotificationPanel"].filter(loaded), "no menu code with the first paint").toEqual([]);

  // Pembanding: the first click opens the list; a pick closes it and shows the choice.
  const compare = page.locator("#dashboard-compare");
  await compare.click();
  await expect(page.getByRole("menuitemradio").first()).toBeVisible();
  const option = page.getByRole("menuitemradio").last();
  const choice = (await option.textContent())!.trim();
  await option.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("#dashboard-compare")).toContainText(choice);

  // The date range opens its presets on the first click and applies one.
  await page.getByRole("button", { name: /hari|Hari ini|Kemarin|Rentang|minggu|bulan/i }).first().click();
  const preset = page.getByRole("button", { name: "Kemarin", exact: true });
  await expect(preset).toBeVisible();
  await preset.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator("section[aria-label='Date range dan pembanding'] button").first()).toContainText("Kemarin");
});
