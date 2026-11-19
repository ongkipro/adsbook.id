// AUTH-LOGIN-REGISTER-UX-SPEC (2026-11-18) in a real browser, local only:
// adsbook.id/masuk and /daftar (their studio layout: auth-studio.spec.ts), one email = one store, staff usernames unique across stores, and
// one sign-in door that lands owners and staff in their own store's admin.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, PLATFORM, signUpThroughWizard, TENANTS } from "./tenants.ts";

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

test("one email = one store; a new owner lands on setup, then signs back in at adsbook.id/masuk", async ({ page }) => {
  // The suite's other signups share an address's 5-per-hour allowance; these come from their own.
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.91" });
  const slug = "toko-pintu-satu";
  const email = "owner@toko-pintu-satu.local.test";
  const password = "password-pintu-123";
  const fill = async (storeName: string, storeSlug: string, ownerEmail: string) => {
    await page.goto(`${PLATFORM}/daftar`);
    await signUpThroughWizard(page, { storeName, slug: storeSlug, email: ownerEmail, password });
  };

  // An email that already owns a store is refused on the email field, in Indonesian, and the
  // wizard returns from step 3 to step 2 with that field focused (AUTH-MINIMALIST-STEP-UX-SPEC §4).
  await fill("Toko Ganda", "toko-ganda-email", owner(TENANTS[0].slug).username);
  await expect(page.locator("#emailError")).toBeVisible();
  await expect(page.locator("#emailError")).toContainText("Email ini sudah terdaftar untuk sebuah toko");
  await expect(page.locator("#stepNow")).toHaveText("2");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();

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
