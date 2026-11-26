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

test("dropdown click-away leaves no lingering focus border and #admin-main stays borderless", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const expectNoFocusBorder = async (locator: ReturnType<Page["locator"]>, label: string) => {
    const state = await locator.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        isActive: document.activeElement === el,
        focusVisible: el.matches(":focus-visible"),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
      };
    });
    expect(state.focusVisible, `${label} must not stay :focus-visible after pointer click-away`).toBe(false);
    expect(state.outlineStyle === "none" || state.outlineWidth === "0px", `${label} must not show an outline`).toBe(true);
  };

  // 1. Dashboard compare dropdown → click empty page area
  const compare = page.locator("#dashboard-compare");
  await compare.click();
  await expect(page.getByRole("menu")).toBeVisible();
  const menuAnim = await page.locator('[data-slot="dropdown-menu-content"]').evaluate((el) => getComputedStyle(el).animationName);
  expect(menuAnim, "admin dropdowns open immediately without decorative animation").toBe("none");
  await page.mouse.click(700, 110);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectNoFocusBorder(compare, "#dashboard-compare");
  await expectNoFocusBorder(page.locator("#admin-main"), "#admin-main");

  // 2. Account menu → click empty page area
  const accountBtn = page.getByRole("button", { name: /^Menu akun/ });
  await accountBtn.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(700, 110);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectNoFocusBorder(accountBtn, "Account menu trigger");

  // 3. Keyboard Escape still restores focus to trigger for accessibility
  await compare.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(compare).toBeFocused();

  // 4. Orders row action menu → click empty area
  await page.goto(`${STORE}/admin/orders`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  const orderAction = page.getByRole("button", { name: /Aksi order/ }).first();
  await orderAction.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(700, 110);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectNoFocusBorder(orderAction, "Orders row action trigger");
  await expectNoFocusBorder(page.locator("#admin-main"), "#admin-main on orders");

  // 5. A dialog closed in code (useConfirm's Batal) by keyboard returns focus to the row menu, never <body>.
  const dialog = page.getByRole("dialog");
  const openDeleteByKeyboard = async () => {
    await orderAction.focus();
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitem", { name: /Hapus pesanan/ });
    await expect(item).toBeVisible();
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
  };
  await openDeleteByKeyboard();
  await dialog.getByRole("button", { name: "Batal" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(orderAction, "keyboard Batal returns focus to the row menu").toBeFocused();

  // 6. The same Batal by mouse leaves no focus ring on the trigger (a pointer user has no focus to lose).
  await orderAction.click();
  await page.getByRole("menuitem", { name: /Hapus pesanan/ }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Batal" }).click();
  await expect(dialog).toHaveCount(0);
  await expectNoFocusBorder(orderAction, "Orders row action trigger after a mouse Batal");

  // 7. Then a keyboard user who tabs into the page again and uses Batal still gets focus back.
  await openDeleteByKeyboard();
  await dialog.getByRole("button", { name: "Batal" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(orderAction, "keyboard after mouse: focus still returns").toBeFocused();
});

test("keyboard focus is visible on the ads tabs and on a shared Button", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);
  const outline = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { focusVisible: el.matches(":focus-visible"), style: cs.outlineStyle, width: cs.outlineWidth };
    });
  for (const path of ["/admin/ads/google", "/admin/ads/meta", "/admin/ads/tiktok"]) {
    await page.goto(`${STORE}${path}`);
    const tab = page.locator(".tab-btn").nth(1);
    await tab.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const state = await outline(tab);
    expect(state.focusVisible, `${path} tab is keyboard-focused`).toBe(true);
    expect(state.style, `${path} tab shows a focus outline`).toBe("solid");
    expect(state.width, `${path} tab focus outline width`).toBe("2px");
    // The strip scrolls sideways (overflow-x-auto): an outside outline would be clipped to its two vertical edges.
    expect(await tab.evaluate((el) => getComputedStyle(el).outlineOffset), `${path} tab outline drawn inside the strip`).toBe("-2px");
  }
  await page.goto(`${STORE}/admin/orders`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  const exportCsv = page.getByRole("button", { name: /Export CSV/ });
  await exportCsv.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const button = await outline(exportCsv);
  expect(button.focusVisible).toBe(true);
  expect(button.style, "a shadcn Button shows a focus outline").toBe("solid");
  // A mouse click on the same button leaves no outline behind.
  await exportCsv.click({ button: "right" }).catch(() => undefined);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 300);
  const afterPointer = await outline(exportCsv);
  expect(afterPointer.focusVisible, "no lingering focus ring after a pointer press").toBe(false);
});

test("the WhatsApp CRM chips read in full in the orders table", async ({ page }) => {
  await signIn(page);
  for (const width of [1280, 1366]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${STORE}/admin/orders`);
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    const group = page.locator('[aria-label="Tabel order desktop"] [aria-label="Tahap follow-up"]').first();
    await expect(group.locator("a, button")).toHaveCount(10);
    // Equal fifths of the 244px column cut "Welcome" and "Process" to "Welc…" (PR #108).
    const cut = await group.locator("span.truncate").evaluateAll((spans) =>
      spans.filter((span) => (span as HTMLElement).scrollWidth > (span as HTMLElement).clientWidth + 0.5).map((span) => span.textContent),
    );
    expect(cut, `no CRM chip label is truncated at ${width}px`).toEqual([]);
  }
});
