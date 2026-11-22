// T-52 (UX-4, UX-7…UX-10) and T-53 (IAM-11): the platform console in a real
// browser — sign in with password + TOTP, open every menu at 390 and 1366 px
// with no console error and no horizontal overflow; add a member behind the
// owner's step-up code, enroll them through their one-time link, see support
// refused the team screen, change their own password (every session closes),
// and reset it through an owner-issued link that still needs their
// authenticator. Local only: workerd, local D1.
import { spawnSync } from "node:child_process";
import { expect, request, test, type Page } from "@playwright/test";
import { hashAdminPassword } from "../../src/lib/admin-credentials.ts";
import { newTotpSecret, totpCode } from "../../src/platform/admin/totp.ts";
import { PLATFORM } from "./tenants.ts";

const OWNER = { email: "owner@console.local.test", password: "console-owner-password-1" };

async function createOwner(): Promise<string> {
  const secret = newTotpSecret();
  const hash = await hashAdminPassword(OWNER.password);
  const sql = `INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_console_owner', '${OWNER.email}', '${hash}', '${secret}', 'platform_owner', '${new Date().toISOString()}') ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, totp_secret = excluded.totp_secret, totp_last_step = NULL, disabled_at = NULL`;
  const result = spawnSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--local", "-c", "dist/server/wrangler.dev-local.json", "--persist-to", ".wrangler/browser-test-state", "--command", sql],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CF_API_TOKEN: "" } },
  );
  if (result.status !== 0) throw new Error(`creating the platform owner failed: ${result.stderr}`);
  return secret;
}

/**
 * A code from a later step than any this account used (each step is claimed
 * once): the next step if the server still accepts it (one step of clock
 * drift), otherwise wait for the clock.
 */
async function freshCode(secret: string, used: Set<number>): Promise<string> {
  const last = used.size ? Math.max(...used) : -1;
  let step = Math.max(Math.floor(Date.now() / 30_000), last + 1);
  while (step > Math.floor(Date.now() / 30_000) + 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
  used.add(step);
  return totpCode(secret, step);
}
const SHOTS = process.env.T53_SHOT_DIR ?? "test-results";

async function signIn(page: Page, email: string, password: string, code: string) {
  await page.goto(`${PLATFORM}/platform/login`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel(/Kode/).fill(code);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(`${PLATFORM}/platform`);
}

// `heading` is the page header (h2, AdminPageHeader); the topbar carries the h1, as in the seller admin.
const MENUS = [
  { name: "Ringkasan", path: "/platform", heading: "Ringkasan platform" },
  { name: "Toko", path: "/platform/tenants", heading: "Toko" },
  { name: "Domain", path: "/platform/domains", heading: "Domain sendiri" },
  { name: "Tagihan", path: "/platform/billing", heading: "Tagihan" },
  { name: "Kesehatan", path: "/platform/health", heading: "Kesehatan platform" },
  { name: "Aktivitas", path: "/platform/activity", heading: "Aktivitas" },
  { name: "Tim", path: "/platform/team", heading: "Tim platform" },
];

test("platform console: every menu at 390 and 1366 px; enrollment link, support refused, own password change, owner reset link", async ({ browser }) => {
  test.setTimeout(240_000);
  const secret = await createOwner();
  const ownerSteps = new Set<number>();
  // One owner sign-in: a TOTP step signs in once, so a second sign-in would wait up to 30 s.
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, OWNER.email, OWNER.password, await freshCode(secret, ownerSteps));
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const menu of MENUS) {
      await page.goto(`${PLATFORM}${menu.path}`);
      await expect(page.getByRole("heading", { level: 2, name: menu.heading, exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${menu.path} at ${width}px overflows`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/console-${width}-${menu.path.replace(/\//g, "_") || "root"}.png`, fullPage: true });
    }
    // The seller-only scroll pad never reaches the platform sidebar: a sidebar click here leaves it unset.
    if (width === 1366) {
      await page.locator('[data-sidebar="content"] a[href="/platform/activity"]').click();
      await page.waitForURL(`${PLATFORM}/platform/activity`);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-restore-pad").trim())).toBe("");
      await expect(page.locator('[data-sidebar="content"]')).toHaveCSS("padding-bottom", "80px");
    }
    // The current page is marked in the navigation (sidebar on desktop, bottom bar on a phone).
    await page.goto(`${PLATFORM}/platform/billing`);
    await expect(page.locator('a[aria-current="page"]:visible').first()).toContainText("Tagihan");
    // A seeded store opens from the list.
    await page.goto(`${PLATFORM}/platform/tenants?q=toko-alfa`);
    await page.locator('a[href^="/platform/tenants/"]:visible', { hasText: "toko-alfa" }).first().click();
    await expect(page.getByRole("heading", { level: 2, name: "toko-alfa", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tagihan langganan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Beri langganan" })).toBeVisible();
  }
  expect(errors, "console errors").toEqual([]);

  // Add a support member, sign in as them, and see the team screen refused.
  await page.setViewportSize({ width: 1366, height: 900 });
  // ⌘K jumps to a menu.
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByPlaceholder(/Ketik menu/).fill("aktivitas");
  await page.keyboard.press("Enter");
  await page.waitForURL(`${PLATFORM}/platform/activity`);

  await page.goto(`${PLATFORM}/platform/team`);
  // Add a member as Owner behind the owner's own fresh code: no password and no secret is shown, only a one-time link.
  const memberEmail = `cs-${Date.now()}@console.local.test`;
  await page.getByRole("button", { name: "Tambah anggota" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(memberEmail);
  await page.locator("#memberRole").click();
  await page.getByRole("menuitemradio", { name: /^Owner/ }).click();
  await expect(page.locator("#memberRole")).toContainText("Owner");
  await expect(dialog.getByLabel(/Password/)).toHaveCount(0);
  await dialog.getByLabel("Kode autentikator Anda (owner)").fill(await freshCode(secret, ownerSteps));
  await dialog.getByRole("button", { name: "Tambah", exact: true }).click();
  await expect(page.locator("#accessLink")).toBeVisible();
  let enrollLink = (await page.locator("#accessLinkValue").textContent())!.trim();
  let staleLink = "";
  expect(enrollLink).toMatch(/\/platform\/akses#[0-9a-f]{64}$/);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${SHOTS}/t53-team-link-${width}.png` });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await dialog.getByRole("button", { name: "Selesai" }).click();
  await page.waitForLoadState("load");
  const row = page.locator("#teamTable tbody tr", { hasText: memberEmail });
  await expect(row).toContainText("Menunggu aktivasi");
  // Change that pending member to Support from the row menu.
  await row.getByRole("button", { name: /Aksi untuk/ }).click();
  await page.getByRole("menuitem", { name: "Ubah peran" }).click();
  await page.locator("#memberRoleEdit").click();
  await page.getByRole("menuitemradio", { name: /^Support/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Simpan peran" }).click();
  await expect(row).toContainText("Support");
  // The role change revoked the link issued under the old role; a fresh one takes another step-up.
  await page.waitForLoadState("load");
  await row.getByRole("button", { name: /Aksi untuk/ }).click();
  await page.getByRole("menuitem", { name: "Tautan aktivasi baru" }).click();
  await page.getByRole("dialog").getByLabel("Kode autentikator Anda (owner)").fill(await freshCode(secret, ownerSteps));
  await page.getByRole("dialog").getByRole("button", { name: "Buat tautan" }).click();
  staleLink = enrollLink;
  enrollLink = (await page.locator("#accessLinkValue").textContent())!.trim();
  expect(enrollLink).not.toBe(staleLink);
  await page.getByRole("dialog").getByRole("button", { name: "Selesai" }).click();

  // The member enrolls: the token leaves the address bar, they prove a code from the new authenticator.
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const member = await memberContext.newPage();
  const tokenRequests: string[] = [];
  member.on("request", (request) => { if (/[0-9a-f]{64}/.test(request.url())) tokenRequests.push(request.url()); });
  await member.goto(staleLink);
  await expect(member.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();
  await member.goto("about:blank"); // a fresh document load, so the response's own headers are read
  const linkPage = await member.goto(enrollLink);
  expect(linkPage?.headers()["referrer-policy"], "the final response keeps no-referrer").toBe("no-referrer");
  const peekResponse = member.waitForResponse((response) => response.url().endsWith("/api/platform/akses"));
  await expect(member.getByRole("heading", { name: "Aktifkan akun console" })).toBeVisible();
  expect((await peekResponse).headers()["referrer-policy"]).toBe("no-referrer");
  expect(new URL(member.url()).hash, "the token is not left in the address bar").toBe("");
  const memberSecret = (await member.locator("#enrolSecret").textContent())!.trim();
  await member.screenshot({ path: `${SHOTS}/t53-enroll-390.png` });
  await member.setViewportSize({ width: 1366, height: 900 });
  await member.screenshot({ path: `${SHOTS}/t53-enroll-1366.png` });
  const memberSteps = new Set<number>();
  await member.getByLabel("Password baru", { exact: true }).fill("member-password-123");
  await member.getByLabel("Ulangi password baru").fill("member-password-123");
  await member.getByLabel(/Kode dari autentikator baru/).fill(await freshCode(memberSecret, memberSteps));
  await member.getByRole("button", { name: "Aktifkan akun" }).click();
  await expect(member.getByRole("heading", { name: "Selesai" })).toBeVisible();
  expect(tokenRequests, "no request URL ever carries the token").toEqual([]);
  // Used is used.
  await member.goto(enrollLink);
  await expect(member.getByRole("heading", { name: "Tautan tidak berlaku" })).toBeVisible();

  // Support signs in and is refused the team screen.
  await signIn(member, memberEmail, "member-password-123", await freshCode(memberSecret, memberSteps));
  await expect(member.locator('a[href="/platform/team"]')).toHaveCount(0);
  const response = await member.goto(`${PLATFORM}/platform/team`);
  expect(response?.status()).toBe(403);
  await expect(member.getByRole("alert").filter({ hasText: "hanya untuk owner platform" })).toBeVisible();
  expect((await member.request.get(`${PLATFORM}/api/platform/team`)).status()).toBe(403);

  // Before (or without) hydration no credential form can submit: POST forms, fields disabled until the script runs.
  const noScript = await browser.newContext({ javaScriptEnabled: false, storageState: await memberContext.storageState(), viewport: { width: 390, height: 844 } });
  const bare = await noScript.newPage();
  const bareUrls: string[] = [];
  bare.on("request", (request) => bareUrls.push(request.url()));
  await bare.goto(`${PLATFORM}/platform/account`);
  await expect(bare.locator("form:has(#currentPassword)")).toHaveAttribute("method", "post");
  for (const id of ["#currentPassword", "#newPassword", "#confirmPassword", "#accountTotp"]) await expect(bare.locator(id)).toBeDisabled();
  await bare.goto(`${PLATFORM}/platform/login`);
  await expect(bare.locator("#loginForm")).toHaveAttribute("method", "post");
  for (const id of ["#email", "#password", "#totp"]) await expect(bare.locator(id)).toBeDisabled();
  await bare.goto(`${PLATFORM}/platform/akses#${"0".repeat(64)}`);
  await expect(bare.locator("#accessForm")).toHaveAttribute("method", "post");
  await expect(bare.locator("#accessForm")).toBeHidden();
  await expect(bare.locator("#password")).toBeDisabled();
  expect(bareUrls.filter((url) => url.includes("?")), "no credential form reached a URL").toEqual([]);
  await noScript.close();

  // Their own password, from the account menu: current password + a fresh code; every session closes, this one too.
  await member.getByRole("button", { name: /Menu akun/ }).click();
  await member.getByRole("menuitem", { name: "Ganti password" }).click();
  await expect(member.getByRole("heading", { level: 2, name: "Akun saya" })).toBeVisible();
  for (const width of [1366, 390]) {
    await member.setViewportSize({ width, height: 900 });
    const overflow = await member.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `/platform/account at ${width}px overflows`).toBeLessThanOrEqual(0);
    await member.screenshot({ path: `${SHOTS}/t53-account-${width}.png`, fullPage: true });
  }
  const oldCookie = (await memberContext.cookies()).find((cookie) => cookie.name === "__Host-adsbook_platform")!.value;
  await member.getByLabel("Password sekarang").fill("member-password-123");
  await member.getByLabel(/Password baru/).fill("member-changed-123");
  await member.getByLabel("Ulangi password baru").fill("member-changed-123");
  await member.getByLabel(/Kode autentikator/).fill(await freshCode(memberSecret, memberSteps));
  await member.getByRole("button", { name: "Ganti password" }).click();
  await member.waitForURL(`${PLATFORM}/platform/login`);
  // The server revoked it: the old cookie, replayed, is no session (401), not merely a support session refused (403).
  const replay = await request.newContext({ extraHTTPHeaders: { cookie: `__Host-adsbook_platform=${oldCookie}` } });
  expect((await replay.get(`${PLATFORM}/api/platform/team`)).status(), "the old session is gone").toBe(401);
  await replay.dispose();

  // The owner issues a reset link (fresh step-up): the support member's sessions close; the link alone is not enough.
  const ownerPage = page;
  await ownerPage.goto(`${PLATFORM}/platform/team`);
  await ownerPage.locator("#teamTable tbody tr", { hasText: memberEmail }).getByRole("button", { name: /Aksi untuk/ }).click();
  await ownerPage.getByRole("menuitem", { name: "Tautan reset password" }).click();
  await ownerPage.getByRole("dialog").getByLabel("Kode autentikator Anda (owner)").fill(await freshCode(secret, ownerSteps));
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Buat tautan" }).click();
  const resetLink = (await ownerPage.locator("#accessLinkValue").textContent())!.trim();
  await context.close();

  await member.goto(resetLink);
  await expect(member.getByRole("heading", { name: "Atur password baru" })).toBeVisible();
  await expect(member.locator("#enrolBox")).toBeHidden();
  for (const width of [1366, 390]) {
    await member.setViewportSize({ width, height: 900 });
    await member.screenshot({ path: `${SHOTS}/t53-reset-${width}.png` });
  }
  await member.getByLabel("Password baru", { exact: true }).fill("member-reset-1234");
  await member.getByLabel("Ulangi password baru").fill("member-reset-1234");
  await member.getByLabel("Kode autentikator").fill("000000");
  await member.getByRole("button", { name: "Simpan password" }).click();
  await expect(member.getByRole("alert")).toContainText("Kode autentikator salah");
  await member.getByLabel("Kode autentikator").fill(await freshCode(memberSecret, memberSteps));
  await member.getByRole("button", { name: "Simpan password" }).click();
  await expect(member.getByRole("heading", { name: "Selesai" })).toBeVisible();
  await signIn(member, memberEmail, "member-reset-1234", await freshCode(memberSecret, memberSteps));
  await memberContext.close();
});
