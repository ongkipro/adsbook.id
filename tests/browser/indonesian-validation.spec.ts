import { expect, test, type Page } from "@playwright/test";
import { origin, owner, PLATFORM, TENANTS } from "./tenants.ts";

/**
 * Paduka (2026-11-18): "please fill out this field" — the browser's own
 * validation bubble, in the browser's language — must never reach anyone.
 * Run in an English browser: the control proves the browser would speak
 * English, then every form we reach answers in Indonesian (inline on the
 * first-met forms, the localized net everywhere else).
 */
test.use({ locale: "en-US" });

const ENGLISH = /Please|fill out|enter an|match the|lengthen|field\./i;

async function browserWouldSayEnglish(page: Page) {
  // A detached field never fires `invalid`, so the net leaves it alone: the browser's own words.
  const native = await page.evaluate(() => {
    const field = document.createElement("input");
    field.required = true;
    return field.validationMessage;
  });
  expect(native, "this browser speaks English").toMatch(ENGLISH);
}

async function inlineError(page: Page, id: string, text: RegExp) {
  await expect(page.locator(`#${id}`)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(`#${id}-error`)).toBeVisible();
  await expect(page.locator(`#${id}-error`)).toHaveText(text);
}

test("first-met forms answer inline in Indonesian: home dialog, store sign-in, platform sign-in", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });

    await page.goto(`${PLATFORM}/`);
    await browserWouldSayEnglish(page);
    await page.locator("#btn-user-auth").click();
    await page.locator("#tab-daftar").click();
    await page.locator("#panel-daftar button[type=submit]").click();
    await inlineError(page, "hero-email", /^Masukkan alamat email Anda terlebih dahulu\.$/);
    await expect(page.locator("#hero-email")).toBeFocused();
    await page.locator("#hero-email").fill("abc");
    await page.locator("#panel-daftar button[type=submit]").click();
    await inlineError(page, "hero-email", /^Format email belum benar/);
    await page.locator("#hero-email").fill("abc@toko.id");
    await expect(page.locator("#hero-email-error"), "clears as soon as it is right").toBeHidden();
    await page.locator("#tab-masuk").click();
    await page.locator("#panel-masuk button[type=submit]").click();
    await inlineError(page, "hero-store", /^Masukkan nama atau domain toko Anda terlebih dahulu\.$/);
    if (width === 1440) {
      // Entry 322's note: the desktop sub-copy sits on two lines, as in the reference.
      await page.keyboard.press("Escape");
      const lines = await page.locator(".hero-sub").evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      expect(lines).toBe(2);
    }

    await page.goto(`${origin(TENANTS[0].slug)}/hello`);
    await page.getByRole("button", { name: "Masuk" }).click();
    await expect(page).toHaveURL(/\/hello$/);
    await inlineError(page, "username", /^Masukkan email atau username Anda\.$/);
    await inlineError(page, "password", /^Masukkan password Anda\.$/);
    await expect(page.locator("#username")).toBeFocused();

    await page.goto(`${PLATFORM}/platform/login`);
    await page.getByRole("button", { name: "Masuk" }).click();
    await inlineError(page, "email", /^Masukkan email akun platform Anda\.$/);
    await inlineError(page, "password", /^Masukkan password Anda\.$/);
    await inlineError(page, "totp", /^Masukkan kode 6 digit dari aplikasi autentikator\.$/);
    await page.locator("#totp").fill("12ab");
    await page.getByRole("button", { name: "Masuk" }).click();
    await inlineError(page, "totp", /^Kode autentikator terdiri dari 6 angka\.$/);
  }
});

test("every other form keeps the browser's checks, in Indonesian: an admin form's bubble and red field", async ({ page }) => {
  const store = TENANTS[0];
  const creds = owner(store.slug);
  await page.goto(`${origin(store.slug)}/hello`);
  await page.getByLabel("Email atau username").fill(creds.username);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);

  await page.goto(`${origin(store.slug)}/admin/products/new`);
  // The form is a React island: before it hydrates, a click submits it the old way.
  await page.waitForFunction(() => !document.querySelector("astro-island[ssr]"));
  await browserWouldSayEnglish(page);
  const form = page.locator("form").filter({ has: page.locator("input[required]") }).first();
  await form.locator("button[type=submit]").last().click();
  const first = form.getByRole("textbox", { name: "Nama produk" });
  await expect(first).toHaveAttribute("aria-invalid", "true");
  const message = await first.evaluate((el: HTMLInputElement) => el.validationMessage);
  expect(message).not.toMatch(ENGLISH);
  expect(message).toBe("Kolom Nama produk wajib diisi.");
  // The label's name, not its hint: <label><span>Slug</span><input/><span>hint</span></label>.
  const slug = form.locator("input[pattern]").first();
  expect(await slug.evaluate((el: HTMLInputElement) => el.validationMessage)).toBe("Kolom Slug wajib diisi.");
  // Typing a valid value releases it: the field never stays stuck invalid.
  await first.fill("Produk Uji Validasi");
  expect(await first.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
  await expect(first).not.toHaveAttribute("aria-invalid", "true");
  // The slug was filled by code from the name (no input event): the next submit click releases our old message.
  await form.locator("button[type=submit]").last().click();
  expect(await slug.evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("Kolom Slug wajib diisi.");
  // Price and weight are still empty: nothing was saved.
  await expect(page).toHaveURL(/\/admin\/products\/new$/);
});
