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
    await expect(dialog.getByLabel("adsbook.id widget embed")).not.toHaveValue("", { timeout: 15_000 });
    return dialog;
  }
  const frameMode = async (snippet: string) => {
    const src = snippet.match(/<iframe[^>]+src="([^"]+)"/)![1].replace(/&amp;/g, "&");
    const html = await (await page.request.get(src)).text();
    return { src, resolved: html.match(/data-resolved-mode="([a-z]+)"/)?.[1] };
  };

  const dialog = await openEmbed(physical!.title);
  await expect(dialog.locator("[data-form-lock=digital]")).toHaveCount(0);
  const mode = dialog.getByRole("combobox", { name: "Mode form" });
  await mode.click();
  await expect(page.getByRole("option")).toHaveText(["Hybrid (otomatis)", "Middle (ringkas)", "Full (lengkap)"]);
  await page.getByRole("option", { name: "Full (lengkap)" }).click();
  const full = await frameMode(await dialog.getByLabel("adsbook.id widget embed").inputValue());
  expect(full.src).toContain("mode=full");
  expect(full.resolved, "a physical product's full snippet renders the full form").toBe("full");
  await expect(dialog.getByRole("link", { name: /Domain untuk embed/ })).toHaveAttribute("href", "/admin/settings/store#embedOriginsForm");
});
