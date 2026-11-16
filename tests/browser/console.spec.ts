// T-52 (UX-4, UX-7…UX-10): the platform console in a real browser — sign in
// with password + TOTP, open every menu at 390 and 1366 px with no console
// error and no horizontal overflow, add a support member, and see support
// refused the team screen. Local only: workerd, local D1.
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
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

/** A code from a step no earlier sign-in used (each step signs in once). */
async function freshCode(secret: string, used: Set<number>): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  while (used.has(step)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    step = Math.floor(Date.now() / 30_000);
  }
  used.add(step);
  return totpCode(secret, step);
}

async function signIn(page: Page, email: string, password: string, code: string) {
  await page.goto(`${PLATFORM}/platform/login`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel(/Kode/).fill(code);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(`${PLATFORM}/platform`);
}

const MENUS = [
  { name: "Ringkasan", path: "/platform", heading: "Ringkasan" },
  { name: "Toko", path: "/platform/tenants", heading: "Toko" },
  { name: "Domain", path: "/platform/domains", heading: "Domain sendiri" },
  { name: "Tagihan", path: "/platform/billing", heading: "Tagihan" },
  { name: "Kesehatan", path: "/platform/health", heading: "Kesehatan platform" },
  { name: "Aktivitas", path: "/platform/activity", heading: "Aktivitas" },
  { name: "Tim", path: "/platform/team", heading: "Tim platform" },
];

test("platform console: every menu at 390 and 1366 px, team add, support refused", async ({ browser }) => {
  const secret = await createOwner();
  const used = new Set<number>();
  for (const width of [1366, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page, OWNER.email, OWNER.password, await freshCode(secret, used));
    for (const menu of MENUS) {
      await page.goto(`${PLATFORM}${menu.path}`);
      await expect(page.getByRole("heading", { level: 1, name: menu.heading })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${menu.path} at ${width}px overflows`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/console-${width}-${menu.path.replace(/\//g, "_") || "root"}.png`, fullPage: true });
    }
    // The current page is marked in the navigation.
    await page.goto(`${PLATFORM}/platform/billing`);
    await expect(page.locator('nav a[aria-current="page"]').first()).toHaveText("Tagihan");
    // A seeded store opens from the list.
    await page.goto(`${PLATFORM}/platform/tenants?q=toko-alfa`);
    await page.getByRole("link", { name: "toko-alfa" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "toko-alfa" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tagihan langganan" })).toBeVisible();
    expect(errors, `console errors at ${width}px`).toEqual([]);
    await context.close();
  }

  // Add a support member, sign in as them, and see the team screen refused.
  const ownerContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, OWNER.email, OWNER.password, await freshCode(secret, used));
  await ownerPage.goto(`${PLATFORM}/platform/team`);
  const supportEmail = `cs-${Date.now()}@console.local.test`;
  await ownerPage.getByLabel("Email", { exact: true }).fill(supportEmail);
  await ownerPage.getByLabel("Peran").selectOption("platform_support");
  await ownerPage.getByLabel(/Password awal/).fill("support-password-123");
  await ownerPage.getByRole("button", { name: "Tambah" }).click();
  await expect(ownerPage.locator("#enrolment")).toBeVisible();
  const supportSecret = (await ownerPage.locator("#enrolSecret").textContent())!.trim();
  await ownerContext.close();

  const supportContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const supportPage = await supportContext.newPage();
  await signIn(supportPage, supportEmail, "support-password-123", await freshCode(supportSecret, new Set()));
  await expect(supportPage.locator("nav").getByRole("link", { name: "Tim" })).toHaveCount(0);
  const response = await supportPage.goto(`${PLATFORM}/platform/team`);
  expect(response?.status()).toBe(403);
  await expect(supportPage.getByRole("alert")).toContainText("hanya untuk owner platform");
  expect((await supportPage.request.get(`${PLATFORM}/api/platform/team`)).status()).toBe(403);
  await supportContext.close();
});
