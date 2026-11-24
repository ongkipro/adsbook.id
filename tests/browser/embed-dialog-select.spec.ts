// Embed dialog (owner, 2026-11-24: "klik drop down varian muncul glitch"):
// the variant list must open in place. It used to be portalled into the
// dialog, where it was a grid row for a frame: the dialog grew 8-16 px and the
// list appeared at one place, then jumped to another. Recorded per animation
// frame from the click, at a desktop and a phone width.
import { expect, test } from "@playwright/test";
import { origin, owner } from "./tenants.ts";

const STORE = origin("toko-alfa");

for (const width of [1366, 390]) {
  test(`Embed dialog at ${width}: the variant list opens in place, the dialog does not move`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    const { username, password } = owner("toko-alfa");
    await page.goto(`${STORE}/hello`);
    await page.getByLabel("Email atau username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Masuk" }).click();
    await page.waitForURL(/\/admin\//);
    await page.goto(`${STORE}/admin/products`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    const actions = page.locator('button[aria-label^="Aksi produk"]:visible');
    for (let index = 0; index < (await actions.count()); index++) {
      await actions.nth(index).click();
      const item = page.getByRole("menuitem", { name: "Embed checkout form" });
      if (await item.count()) {
        await item.click();
        break;
      }
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Snippet widget")).not.toHaveValue("", { timeout: 15_000 });
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const frames: Array<{ popup: number[] | null; dialog: number[] }> = [];
      (window as unknown as { __frames: typeof frames }).__frames = frames;
      const start = performance.now();
      const tick = () => {
        const popup = document.querySelector('[data-slot="select-content"]')?.getBoundingClientRect();
        const box = document.querySelector('[data-slot="dialog-content"]')!.getBoundingClientRect();
        frames.push({ popup: popup ? [Math.round(popup.left), Math.round(popup.top)] : null, dialog: [Math.round(box.top), Math.round(box.height)] });
        if (performance.now() - start < 700) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await dialog.getByRole("combobox", { name: "Varian awal" }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.waitForTimeout(800);
    const frames = await page.evaluate(() => (window as unknown as { __frames: Array<{ popup: number[] | null; dialog: number[] }> }).__frames);

    const dialogStates = new Set(frames.map((frame) => frame.dialog.join(",")));
    expect([...dialogStates], "the dialog keeps its place and height while the list opens").toHaveLength(1);
    const popupStates = new Set(frames.filter((frame) => frame.popup).map((frame) => frame.popup!.join(",")));
    expect([...popupStates], "the list appears where it stays").toHaveLength(1);

    // Inside the dialog and the screen, and picking still works.
    const fit = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="select-content"]')!.getBoundingClientRect();
      const box = document.querySelector('[data-slot="dialog-content"]')!.getBoundingClientRect();
      return popup.left >= box.left - 1 && popup.right <= box.right + 1 && document.documentElement.scrollWidth <= innerWidth;
    });
    expect(fit).toBe(true);
    const last = page.getByRole("option").last();
    const label = (await last.textContent())!.trim();
    await last.click();
    await expect(dialog.getByRole("combobox", { name: "Varian awal" })).toContainText(label);
    await expect(dialog.getByLabel("Snippet widget")).toHaveValue(/variant-id="\d+"/);
  });
}
