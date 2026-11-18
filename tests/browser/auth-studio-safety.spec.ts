// AUTH-MINIMALIST-STEP-UX-SPEC review (Panel 2, 30b9504): the signup never
// spends an attempt without a bot-check token, never sends what was edited
// after the click, and never leaves step 1 on a stale or server-refused
// address. Local only. The provider is faked in the browser: the page is
// switched from the local stand-in to the real widget path, and api.js is
// replaced by a script whose token the test hands over (or never does). The
// token it hands over is the stand-in's, so the local server verifies it for real.
import { expect, test, type Page, type Request } from "@playwright/test";
import { origin, PLATFORM, signUpThroughWizard } from "./tenants.ts";

const FAKE_API = `(() => {
  const onload = new URL(document.currentScript.src).searchParams.get("onload");
  const fake = (window.__fakeTurnstile = { renders: 0, resets: 0, options: null });
  window.turnstile = {
    render(element, options) { fake.renders += 1; fake.options = options; return "fake-widget"; },
    reset() { fake.resets += 1; },
  };
  fake.solve = () => fake.options.callback("local-stand-in");
  window[onload]();
})();`;

/** /daftar on the real widget path, with api.js faked (`manual`) or unreachable (`fail`). */
async function withProvider(page: Page, mode: "manual" | "fail") {
  await page.route(`${PLATFORM}/daftar`, async (route) => {
    const response = await route.fetch();
    const html = (await response.text())
      .replace(/data-standin(="[^"]*")?/, 'data-standin=""')
      .replace(/data-sitekey(="[^"]*")?/, 'data-sitekey="test-site-key"')
      .replace("</form>", '<div id="turnstileWidget" class="turnstile-slot"></div></form>');
    await route.fulfill({ response, body: html });
  });
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
    mode === "fail" ? route.abort() : route.fulfill({ contentType: "application/javascript", body: FAKE_API }),
  );
}

function signupPosts(page: Page) {
  const posts: Array<Record<string, unknown>> = [];
  page.on("request", (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/platform/signup") posts.push(request.postDataJSON());
  });
  return posts;
}

const ready = (page: Page) => page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");

test("no token, no request: a slow check keeps the seller's progress; a late token sends exactly what was clicked", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.120" });
  await withProvider(page, "manual");
  const posts = signupPosts(page);
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  const options = await page.evaluate(() => {
    const options = (window as unknown as { __fakeTurnstile: { options: Record<string, unknown> } }).__fakeTurnstile.options;
    return { appearance: options.appearance, size: options.size, theme: options.theme, sitekey: options.sitekey };
  });
  expect(options).toEqual({ appearance: "interaction-only", size: "flexible", theme: "light", sitekey: "test-site-key" });
  await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "pending");

  const store = { storeName: "Toko Token Lambat", slug: "toko-token-lambat", email: "owner@token-lambat.local.test", password: "password-token-123" };
  await signUpThroughWizard(page, store);
  // Waiting for the token: the button says so, and nothing the request would send can change.
  await expect(page.locator("#submitSignup")).toHaveText("Menyelesaikan verifikasi keamanan…");
  await expect(page.getByRole("button", { name: "← Kembali" })).toBeDisabled();
  for (const panel of ["1", "2", "3"]) await expect(page.locator(`[data-step-panel="${panel}"]`)).toHaveAttribute("inert", "");
  // The token never comes: no request, the check is left as it is, the seller can try again.
  await expect(page.locator("#turnstileError")).toContainText("Verifikasi keamanan belum selesai", { timeout: 8_000 });
  expect(posts, "no signup request without a token").toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { __fakeTurnstile: { resets: number } }).__fakeTurnstile.resets)).toBe(0);
  await expect(page.locator("#submitSignup")).toBeEnabled();
  await expect(page.locator("#submitSignup")).toHaveText("Buat Toko Gratis →");
  await expect(page.getByRole("button", { name: "← Kembali" })).toBeEnabled();
  await expect(page.locator("#stepNow")).toHaveText("3");

  // Second click; while it waits, the fields change behind the lock. The late token sends the clicked values.
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
  await expect(page.locator("#submitSignup")).toHaveText("Menyelesaikan verifikasi keamanan…");
  await page.evaluate(() => {
    (document.getElementById("email") as HTMLInputElement).value = "diubah@token-lambat.local.test";
    (document.getElementById("slug") as HTMLInputElement).value = "alamat-diubah";
    (document.getElementById("storeName") as HTMLInputElement).value = "Nama Diubah";
  });
  expect(posts).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { __fakeTurnstile: { solve(): void } }).__fakeTurnstile.solve());
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ store_name: store.storeName, slug: store.slug, email: store.email, turnstile_token: "local-stand-in" });
  await page.waitForURL(`${origin(store.slug)}/admin/setup?welcome=1`, { timeout: 60_000 });
});

test("a provider script that never loads says so, and still sends nothing", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.121" });
  await withProvider(page, "fail");
  const posts = signupPosts(page);
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "error");
  await signUpThroughWizard(page, { storeName: "Toko Tanpa Skrip", email: "owner@tanpa-skrip.local.test", password: "password-skrip-123" });
  await expect(page.locator("#turnstileError")).toHaveText("Pemeriksaan keamanan gagal dimuat. Periksa koneksi, lalu muat ulang halaman.");
  await expect(page.locator("#submitSignup")).toBeEnabled();
  expect(posts).toHaveLength(0);
});

test("step 1 never advances on a stale address check: a name cleared or an address shortened while it runs", async ({ page }) => {
  // Every check of these addresses answers 1.5 s late.
  await page.route(/\/api\/platform\/slug\?slug=toko-lambat/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  const next = page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" });

  await page.getByLabel("Nama toko").fill("Toko Lambat");
  await next.click();
  await page.getByLabel("Nama toko").fill("");
  // At once: the superseded check settles, it is not left to the 3-second safety timeout.
  await expect(page.locator("#storeNameError")).toHaveText("Isi nama toko.", { timeout: 2_000 });
  await expect(page.locator("#stepNow")).toHaveText("1");

  await page.getByLabel("Nama toko").fill("Toko Lambat Dua");
  await page.getByRole("button", { name: "Ubah" }).click();
  await next.click();
  await page.getByLabel("Alamat toko", { exact: true }).fill("ab");
  await expect(page.locator("#slugError")).toHaveText("Alamat toko minimal 3 karakter.", { timeout: 2_000 });
  await expect(page.locator("#stepNow")).toHaveText("1");
  await page.waitForTimeout(2_000);
  await expect(page.locator("#stepNow"), "the late answer moves nothing").toHaveText("1");
});

test("an address the server refuses stays refused until it changes; a suggestion keeps keyboard focus on the address", async ({ page }) => {
  let refused = false;
  await page.route(`${PLATFORM}/api/platform/signup`, async (route) => {
    if (refused) return route.continue();
    refused = true;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "Pendaftaran gagal.", errors: { slug: "Alamat toko ini baru saja dipakai." }, suggestions: ["toko-tabrakan-baru"] }),
    });
  });
  await page.goto(`${PLATFORM}/daftar`);
  await signUpThroughWizard(page, { storeName: "Toko Tabrakan", email: "owner@tabrakan.local.test", password: "password-tabrakan-123" });
  // Back on step 1, on the address, which the pill now marks unavailable.
  await expect(page.locator("#stepNow")).toHaveText("1");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeFocused();
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini baru saja dipakai.");
  await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
  await expect(page.locator("#slugError")).toHaveText("Pilih alamat toko yang tersedia.");
  await expect(page.locator("#stepNow")).toHaveText("1");
  // A suggestion fills the address and keeps the keyboard on it.
  await page.getByRole("button", { name: "toko-tabrakan-baru" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toHaveValue("toko-tabrakan-baru");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeFocused();
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
  await page.getByRole("button", { name: "Lanjut ke Akun Pemilik →" }).click();
  await expect(page.locator("#stepNow")).toHaveText("2");
});

test("a lost answer spends the token: the check is reset, and a retry waits for a fresh token before it sends", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.122" });
  await withProvider(page, "manual");
  const posts = signupPosts(page);
  // The first request goes out and its answer never comes back (the server may have spent the token).
  let lost = false;
  await page.route(`${PLATFORM}/api/platform/signup`, (route) => {
    if (lost) return route.continue();
    lost = true;
    return route.abort("connectionreset");
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await page.evaluate(() => (window as unknown as { __fakeTurnstile: { solve(): void } }).__fakeTurnstile.solve());
  await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "ok");
  const store = { storeName: "Toko Jawaban Hilang", slug: "toko-jawaban-hilang", email: "owner@jawaban-hilang.local.test", password: "password-hilang-123" };
  await signUpThroughWizard(page, store);
  await expect(page.locator("#errorSummary")).toContainText("Koneksi terputus");
  await expect.poll(() => posts.length).toBe(1);
  // The spent token is gone and the real widget was reset for a fresh one.
  expect(await page.evaluate(() => (window as unknown as { __fakeTurnstile: { resets: number } }).__fakeTurnstile.resets)).toBe(1);
  await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "pending");
  await expect(page.locator("#submitSignup")).toBeEnabled();
  // Retry: no second request until the fresh token arrives, then exactly one, which lands.
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
  await expect(page.locator("#submitSignup")).toHaveText("Menyelesaikan verifikasi keamanan…");
  await page.waitForTimeout(500);
  expect(posts, "the stale token is never resent").toHaveLength(1);
  await page.evaluate(() => (window as unknown as { __fakeTurnstile: { solve(): void } }).__fakeTurnstile.solve());
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ slug: store.slug, email: store.email, turnstile_token: "local-stand-in" });
  await page.waitForURL(`${origin(store.slug)}/admin/setup?welcome=1`, { timeout: 60_000 });
});

