// AUTH-LOGIN-REGISTER-UX-SPEC (2026-11-18) in a real browser, local only:
// adsbook.id/masuk and /daftar as one split-screen pair (form first on a
// phone), one email = one store, staff usernames unique across stores, and
// one sign-in door that lands owners and staff in their own store's admin.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, PLATFORM, TENANTS } from "./tenants.ts";

const shots = process.env.AUTH_SHOT_DIR;

/** A same-origin JSON call from the page, as the admin's own screens make it (CSRF gate). */
async function pageFetch(page: Page, path: string, method: string, body?: unknown) {
  return page.evaluate(async ([path, method, body]) => {
    const response = await fetch(path as string, { method: method as string, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  }, [path, method, body] as const);
}

async function signInAtHello(page: Page, slug: string) {
  const { username, password } = owner(slug);
  await page.goto(`${origin(slug)}/hello`);
  await page.getByLabel("Email atau username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/admin\//);
}

async function signInAtMasuk(page: Page, identifier: string, password: string) {
  await page.goto(`${PLATFORM}/masuk`);
  await page.getByLabel("Email atau username").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk ke Dashboard →" }).click();
}

test("the pair at 1440 and 390: switcher, the form in the first viewport on a phone, two catalog choices with the hybrid note", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${PLATFORM}/masuk`);
    await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Masuk ke Toko");
    const field = await page.locator("#loginPassword").boundingBox();
    expect(field!.y + field!.height, `/masuk ${width}: both fields above the fold`).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/auth-masuk-${width}.png`, fullPage: true });

    await page.goto(`${PLATFORM}/daftar`);
    await expect(page.locator(".auth-switch a[aria-current=page]")).toHaveText("Buat Toko Baru");
    await expect(page.locator('input[name="catalog_mode"]')).toHaveCount(2);
    await expect(page.locator('input[name="catalog_mode"][value="hybrid"]')).toHaveCount(0);
    await expect(page.locator(".catalog-hint")).toContainText("Satu toko bisa keduanya");
    // Said once, under the choices; the panel's first point names hybrid without repeating the paragraph.
    await expect(page.getByText("Satu toko sebenarnya mendukung")).toHaveCount(0);
    await expect(page.locator(".foundation-list")).toContainText("Bebas jual fisik, digital, maupun hybrid");
    const name = await page.locator("#storeName").boundingBox();
    expect(name!.y + name!.height, `/daftar ${width}: the form starts above the fold`).toBeLessThanOrEqual(height);
    // The panel's "after signup" note follows the chosen focus.
    await expect(page.locator('[data-next-steps="physical"]')).toBeVisible();
    await page.getByRole("radio", { name: /Produk Digital/ }).check();
    await expect(page.locator('[data-next-steps="digital"]')).toBeVisible();
    await expect(page.locator('[data-next-steps="physical"]')).toBeHidden();
    await page.getByRole("radio", { name: /Produk Fisik/ }).check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/auth-daftar-${width}.png`, fullPage: true });
  }
});

test("one email = one store; a new owner lands on setup, then signs back in at adsbook.id/masuk", async ({ page }) => {
  // The suite's other signups share an address's 5-per-hour allowance; these come from their own.
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.91" });
  const slug = "toko-pintu-satu";
  const email = "owner@toko-pintu-satu.local.test";
  const password = "password-pintu-123";
  const fill = async (storeName: string, storeSlug: string, ownerEmail: string) => {
    await page.goto(`${PLATFORM}/daftar`);
    await page.getByLabel("Nama toko").fill(storeName);
    await page.getByLabel("Alamat toko", { exact: true }).fill(storeSlug);
    await expect(page.locator("#slugHint")).toContainText("tersedia.", { timeout: 15_000 });
    await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
  };

  // An email that already owns a store is refused on the email field, in Indonesian.
  await fill("Toko Ganda", "toko-ganda-email", owner(TENANTS[0].slug).username);
  await expect(page.locator("#emailError")).toBeVisible();
  await expect(page.locator("#emailError")).toContainText("Email ini sudah terdaftar untuk sebuah toko");

  // A new store: the handoff lands on setup, with the physical first steps and the hybrid note.
  await fill("Toko Pintu Satu", slug, email);
  await page.waitForURL(`${origin(slug)}/admin/setup?welcome=1`, { timeout: 60_000 });
  for (const step of ["Tambah produk fisik pertama", "Lengkapi alamat pickup / gudang utama", "Simpan API key Mengantar"]) {
    await expect(page.getByText(step).first()).toBeVisible();
  }
  await expect(page.locator('[data-hybrid-note="physical"]')).toContainText("Hybrid");

  // Signed out, the owner comes back through the one door with email + password.
  await pageFetch(page, "/api/admin/logout", "POST");
  await signInAtMasuk(page, "owner@toko-pintu-satu.local.test", "salah-salah-salah");
  await expect(page.locator("#loginError")).toHaveText("Email/username atau password belum sesuai.");
  await expect(page).toHaveURL(`${PLATFORM}/masuk`);
  await signInAtMasuk(page, email.toUpperCase(), password);
  await page.waitForURL(`${origin(slug)}/admin/dashboard`, { timeout: 30_000 });
});

test("a staff username is unique across stores, and that staff member signs in at adsbook.id/masuk", async ({ page }) => {
  const [alfa, beta] = TENANTS;
  const staff = { username: "cs_rina", display_name: "Rina CS", email: "rina@cs.local.test", password: "rina-password-123", role: "customer_service" };
  await signInAtHello(page, alfa.slug);
  const created = await pageFetch(page, "/api/admin/access", "POST", staff);
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  await pageFetch(page, "/api/admin/logout", "POST");

  await signInAtHello(page, beta.slug);
  const clash = await pageFetch(page, "/api/admin/access", "POST", { ...staff, email: "" });
  expect(clash.status).toBe(409);
  expect(clash.json.error).toMatch(/sudah digunakan/);
  await pageFetch(page, "/api/admin/logout", "POST");

  // The staff member types only the username; the store is found, the password change comes first.
  await signInAtMasuk(page, "cs_rina", staff.password);
  await page.waitForURL(`${origin(alfa.slug)}/admin/profile`, { timeout: 30_000 });
  await pageFetch(page, "/api/admin/logout", "POST");
  // The email it was given opens the same account.
  await signInAtMasuk(page, staff.email, staff.password);
  await page.waitForURL(`${origin(alfa.slug)}/admin/profile`, { timeout: 30_000 });
});
