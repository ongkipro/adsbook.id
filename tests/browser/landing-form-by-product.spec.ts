// Landing page editor and product Embed dialog (owner, 2026-11-23): the
// checkout a form renders is set by the product. A physical product picks one of the three COD forms
// (hybrid, middle, full), each with its own hint; a digital product's form is
// locked to the digital checkout, as GeoIpResolvedForm already enforces on the
// store. The physical half runs on the global setup's toko-alfa (a physical
// catalog); the digital half is in digital-products.spec.ts, on its digital store.
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

async function openEditorWith(page: Page, productTitle: RegExp) {
  await page.goto(`${STORE}/admin/landing-pages/new`);
  await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
  await page.getByRole("combobox").filter({ hasText: /Pilih produk/ }).click();
  await page.getByRole("option", { name: productTitle }).first().click();
  await page.getByRole("button", { name: /Form COD/ }).click();
}

test("a physical product picks hybrid, middle or full, in the landing editor and the Embed dialog", async ({ page }) => {
  await signIn(page);
  const products = await (await page.request.get(`${STORE}/api/admin/products`)).json();
  const rows = (products.data?.products ?? products.data ?? []) as Array<{ title: string; product_type: string; is_active: boolean | number }>;
  const physical = rows.find((row) => row.product_type === "physical" && (row.is_active === true || row.is_active === 1));
  expect(physical, "the seeded store has an active physical product").toBeTruthy();
  // Physical: three forms, each with a hint, and the choice sticks.
  await openEditorWith(page, new RegExp(physical!.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(page.locator("[data-form-lock=digital]")).toHaveCount(0);
  const kind = page.getByRole("combobox", { name: "Jenis form" });
  await expect(kind).toContainText("Hybrid (otomatis)");
  await expect(page.getByText(/Ringkas di provinsi COD, lengkap di provinsi tanpa COD/)).toBeVisible();
  await kind.click();
  await expect(page.getByRole("option")).toHaveText(["Hybrid (otomatis)", "Middle (ringkas)", "Full (lengkap)"]);
  await page.getByRole("option", { name: "Full (lengkap)" }).click();
  await expect(kind).toContainText("Full (lengkap)");
  await expect(page.getByText(/Alamat lengkap sampai kecamatan dan pilihan kurir/)).toBeVisible();

  // Embed dialog: the same rule, and the snippet's frame renders the matching form.
  async function openEmbed(title: string) {
    await page.goto(`${STORE}/admin/products`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));
    await page.locator(`button[aria-label="Aksi produk ${title}"]:visible`).first().click();
    await page.getByRole("menuitem", { name: "Embed checkout form" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Snippet widget")).not.toHaveValue("", { timeout: 15_000 });
    return dialog;
  }
  const frameMode = async (snippet: string) => {
    const src = snippet.match(/<iframe[^>]+src="([^"]+)"/)![1].replace(/&amp;/g, "&");
    const html = await (await page.request.get(src)).text();
    return { src, resolved: html.match(/data-resolved-mode="([a-z]+)"/)?.[1] };
  };

  const dialog = await openEmbed(physical!.title);
  await expect(dialog.locator("[data-form-lock=digital]")).toHaveCount(0);
  const modes = dialog.getByRole("radiogroup", { name: "Mode form" }).getByRole("radio");
  await expect(modes).toHaveText(["Hybrid", "Middle", "Full"]);
  await expect(modes.first()).toHaveAttribute("aria-checked", "true");
  // A radio group, not three buttons: one tab stop, and the arrow keys move the choice.
  await modes.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(modes.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(modes.nth(1)).toBeFocused();
  expect(await modes.evaluateAll((items) => items.filter((item) => (item as HTMLElement).tabIndex === 0).length)).toBe(1);
  await dialog.getByRole("radio", { name: "Full" }).click();
  await expect(dialog.getByText("Alamat lengkap sampai kecamatan dan pilihan kurir.")).toBeVisible();
  const full = await frameMode(await dialog.getByLabel("Snippet widget").inputValue());
  expect(full.src).toContain("mode=full");
  expect(full.resolved, "a physical product's full snippet renders the full form").toBe("full");
  await expect(dialog.getByRole("link", { name: /Domain untuk embed/ })).toHaveAttribute("href", "/admin/settings/store#embedOriginsForm");
  // Three outputs, one copy button that names what it copies; the link needs no allowlist.
  await dialog.getByRole("tab", { name: "Link" }).click();
  await expect(dialog.getByLabel("Link form")).toHaveValue(/\/full-form\?product_id=/);
  await expect(dialog.getByRole("button", { name: "Salin link" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Domain untuk embed/ })).toHaveCount(0);
  // The variant list opens inside the dialog, never past its edge or the screen's,
  // on a desktop and on a phone (each a fresh open, as a seller would).
  await page.keyboard.press("Escape");
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 860 });
    const fresh = await openEmbed(physical!.title);
    await fresh.getByRole("combobox", { name: "Varian awal" }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => {
      const popup = document.querySelector('[data-slot="select-content"]')!.getBoundingClientRect();
      const box = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
      const frame = box.getBoundingClientRect();
      return { inside: popup.left >= frame.left - 1 && popup.right <= frame.right + 1, sideways: box.scrollWidth > box.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth };
    });
    expect(fit, `variant list at ${width}`).toEqual({ inside: true, sideways: false, page: false });
    await page.getByRole("option").first().click();
    await page.keyboard.press("Escape");
  }
});
