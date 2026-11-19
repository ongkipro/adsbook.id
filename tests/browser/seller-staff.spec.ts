// Seller staff, end to end through the ordinary UI (local fixtures only): the
// owner adds a staff member on /admin/settings/access; the member signs in on
// adsbook.id/masuk with the username they were given, follows the login
// handoff to their own store, must replace the temporary password first, then
// reaches exactly their role's pages; revoking access ends their session at once.
import { expect, test, type Page } from "@playwright/test";
import { origin, owner, PLATFORM, TENANTS } from "./tenants.ts";

async function signInAtMasuk(page: Page, identifier: string, password: string) {
  await page.goto(`${PLATFORM}/masuk`);
  await page.getByLabel("Email atau username").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Masuk ke Dashboard →" }).click();
}

/** Typed before the React island hydrates, a value is wiped by its first render. */
const hydrated = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll("astro-island")].every((el) => !el.hasAttribute("ssr")));

/** A same-origin JSON call from the page, as the admin's own screens make it. */
async function pageFetch(page: Page, path: string) {
  return page.evaluate(async (path) => (await fetch(path, { headers: { Accept: "application/json" } })).status, path);
}

test("seller staff: added in the dashboard, signs in at /masuk by username into the right store, changes the temporary password first, sees only the CS pages, and is shut out the moment access is revoked", async ({ browser }) => {
  test.setTimeout(120_000);
  const [alfa, beta] = TENANTS;
  const store = origin(alfa.slug);
  const staff = { name: "Dewi CS", username: "cs_dewi", temporary: "sementara-dewi-1", password: "dewi-password-baru-1" };

  // The owner adds a CS member from the seller dashboard.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signInAtMasuk(ownerPage, owner(alfa.slug).username, owner(alfa.slug).password);
  await ownerPage.waitForURL(`${store}/admin/dashboard`, { timeout: 30_000 });
  await ownerPage.goto(`${store}/admin/settings/access`);
  await hydrated(ownerPage);
  // The list's first load must land before a member is added (see the reproduction test below).
  await expect(ownerPage.getByText(`@${owner(alfa.slug).username}`)).toBeVisible();
  await ownerPage.getByLabel(/Nama Lengkap/).fill(staff.name);
  await ownerPage.getByRole("combobox", { name: "Role" }).click();
  await ownerPage.getByRole("option", { name: /^Operator CS/ }).click();
  await ownerPage.getByLabel(/Username Login/).fill(staff.username);
  await ownerPage.getByLabel(/Password Sementara/).fill(staff.temporary);
  await ownerPage.getByRole("button", { name: "Tambah Pengguna Baru" }).click();
  await expect(ownerPage.getByText(`@${staff.username}`)).toBeVisible();

  // The member signs in on the platform's door with the username, and lands in their own store — on the password step.
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signInAtMasuk(staffPage, staff.username, staff.temporary);
  await staffPage.waitForURL(`${store}/admin/profile`, { timeout: 30_000 });
  await expect(staffPage.getByRole("heading", { level: 2, name: "Amankan akun admin" })).toBeVisible();
  await staffPage.goto(`${store}/admin/orders`);
  await expect(staffPage, "nothing else opens before the password is replaced").toHaveURL(`${store}/admin/profile`);

  // First-login password step.
  await staffPage.locator("#currentPassword").fill(staff.temporary);
  await staffPage.locator("#newPassword").fill(staff.password);
  await staffPage.locator("#confirmPassword").fill(staff.password);
  await staffPage.getByRole("button", { name: "Simpan Profil" }).click();
  await staffPage.waitForURL(`${store}/hello`, { timeout: 15_000 });

  // The temporary password is spent; the new one signs in at /masuk and lands on the role's default page.
  await signInAtMasuk(staffPage, staff.username, staff.temporary);
  await expect(staffPage.locator("#loginError")).toHaveText("Email/username atau password belum sesuai.", { timeout: 15_000 });
  await signInAtMasuk(staffPage, staff.username, staff.password);
  await staffPage.waitForURL(`${store}/admin/dashboard`, { timeout: 30_000 });

  // Access matches the role: CS pages open, owner-only and ads pages do not, nor their APIs, nor another store.
  await staffPage.goto(`${store}/admin/orders`);
  await expect(staffPage).toHaveURL(`${store}/admin/orders`);
  for (const path of ["/admin/settings/access", "/admin/products", "/admin/billing"]) {
    await staffPage.goto(`${store}${path}`);
    await expect(staffPage, `${path} is not a CS page`).toHaveURL(`${store}/admin/dashboard`);
  }
  expect(await pageFetch(staffPage, "/api/admin/access")).toBe(403);
  await staffPage.goto(`${origin(beta.slug)}/admin/dashboard`);
  await expect(staffPage, "the session belongs to its own store").toHaveURL(/\/hello/);

  // The owner revokes access from the same screen; the member's live session ends on the next request.
  await ownerPage.reload();
  await hydrated(ownerPage);
  const row = ownerPage.locator("article", { hasText: `@${staff.username}` }); // one card per account
  await row.getByTitle("Cabut akses").click();
  await ownerPage.getByRole("dialog", { name: "Cabut akses akun?" }).getByRole("button", { name: "Cabut akses" }).click();
  await expect(ownerPage.getByText(`@${staff.username}`)).toHaveCount(0);
  await staffPage.goto(`${store}/admin/orders`);
  await expect(staffPage, "revoked: the session is gone").toHaveURL(/\/hello/);
  await signInAtMasuk(staffPage, staff.username, staff.password);
  await expect(staffPage.locator("#loginError")).toHaveText("Email/username atau password belum sesuai.", { timeout: 15_000 });

  await staffContext.close();
  await ownerContext.close();
});

// Regression (2026-11-19): the access list loads once on mount. Its answer used to replace the list whenever it
// arrived, so an answer that landed after "Tambah Pengguna Baru" removed the new member from the screen although the
// account was created (201). Dropping that late answer alone would hide every member that already existed, so the
// fix reads the list again after each change. Here the first answer is held back until the new member is created.
test("a slow first list answer can hide neither an existing member nor one just added, and Refresh matches the server", async ({ page }) => {
  const [alfa] = TENANTS;
  const store = origin(alfa.slug);
  await signInAtMasuk(page, owner(alfa.slug).username, owner(alfa.slug).password);
  await page.waitForURL(`${store}/admin/dashboard`, { timeout: 30_000 });

  // An existing member, added the ordinary way.
  await page.goto(`${store}/admin/settings/access`);
  await hydrated(page);
  await expect(page.getByText(`@${owner(alfa.slug).username}`)).toBeVisible();
  await page.getByLabel(/Nama Lengkap/).fill("Lama CS");
  await page.getByLabel(/Username Login/).fill("cs_lama");
  await page.getByLabel(/Password Sementara/).fill("sementara-lama-1");
  await page.getByRole("button", { name: "Tambah Pengguna Baru" }).click();
  await expect(page.getByText("@cs_lama")).toBeVisible();

  // The next page load: its first list answer (read before the new member exists) is delivered only after the 201.
  let releaseFirstLoad!: () => void;
  const memberCreated = new Promise<void>((resolve) => (releaseFirstLoad = resolve));
  let firstLoadServed!: () => void;
  const firstLoadDone = new Promise<void>((resolve) => (firstLoadServed = resolve));
  let first = true;
  await page.route(`${store}/api/admin/access`, async (route) => {
    if (route.request().method() !== "GET" || !first) return route.continue(); // untouched: the browser's own request
    first = false;
    const response = await route.fetch(); // the list as it was before the new member existed…
    await memberCreated; // …delivered only after the page has the 201
    await route.fulfill({ response });
    firstLoadServed();
  });
  await page.reload();
  await hydrated(page);
  await page.getByLabel(/Nama Lengkap/).fill("Budi Ads");
  await page.getByLabel(/Username Login/).fill("ads_budi");
  await page.getByLabel(/Password Sementara/).fill("sementara-budi-1");
  const createdResponse = page.waitForResponse((response) => response.url() === `${store}/api/admin/access` && response.request().method() === "POST");
  await page.getByRole("button", { name: "Tambah Pengguna Baru" }).click();
  expect((await createdResponse).status(), "the account is created").toBe(201);
  await expect(page.getByLabel(/Username Login/), "the form has taken the 201 (it clears)").toHaveValue("");
  releaseFirstLoad();
  await firstLoadDone;

  // The server's own list, read by the page's session: the screen must end equal to it.
  const serverUsernames = async () =>
    (await page.evaluate(async () => (await (await fetch("/api/admin/access", { headers: { Accept: "application/json" } })).json()).data.users.map((user: { username: string }) => user.username))) as string[];
  const shownUsernames = async () => (await page.locator("article").allTextContents()).length;
  const expectScreenMatchesServer = async (label: string) => {
    const expected = await serverUsernames();
    expect(expected).toEqual(expect.arrayContaining([owner(alfa.slug).username, "cs_lama", "ads_budi"]));
    for (const username of expected) await expect(page.getByText(`@${username}`), `${label}: @${username}`).toHaveCount(1);
    await expect.poll(shownUsernames, { message: `${label}: no extra card` }).toBe(expected.length);
  };
  // Settled: Refresh is enabled again only once no list read is pending.
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expectScreenMatchesServer("after the slow first answer");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expectScreenMatchesServer("after Refresh");
});
