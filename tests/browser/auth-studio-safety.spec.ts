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
      .replace("</form>", '</form><div id="turnstileWidget" class="turnstile-slot"></div>'); // where the real page renders it
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
  // Waiting for the token: the button says so, a status outside the inert steps announces it,
  // and nothing the request would send can change.
  await expect(page.locator("#submitSignup")).toHaveText("Menyelesaikan verifikasi keamanan…");
  await expect(page.getByRole("status")).toHaveText("Menyelesaikan verifikasi keamanan…");
  expect(await page.locator("#progressNote").evaluate((element) => element.closest('[inert], [aria-busy="true"]') === null), "the wait is announced outside inert and busy").toBe(true);
  expect(await page.locator("#turnstileWidget").evaluate((element) => element.closest('[inert], [aria-busy="true"]') === null), "the check stays usable").toBe(true);
  await expect(page.getByRole("button", { name: "← Kembali" })).toBeDisabled();
  for (const panel of ["1", "2", "3"]) await expect(page.locator(`[data-step-panel="${panel}"]`)).toHaveAttribute("inert", "");
  // The token never comes: no request, the check is left as it is, the seller can try again.
  await expect(page.locator("#turnstileError")).toContainText("Verifikasi keamanan belum selesai", { timeout: 8_000 });
  expect(posts, "no signup request without a token").toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { __fakeTurnstile: { resets: number } }).__fakeTurnstile.resets)).toBe(0);
  await expect(page.locator("#submitSignup")).toBeEnabled();
  await expect(page.locator("#submitSignup")).toHaveText("Buat Toko Gratis →");
  await expect(page.locator("#submitSignup"), "focus returns to the button, not to the page").toBeFocused();
  await expect(page.locator("#progressNote")).toBeHidden();
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

test("step 1 never advances on a stale address check: an address cleared or shortened while it runs", async ({ page }) => {
  // Every check of these addresses answers 1.5 s late.
  await page.route(/\/api\/platform\/slug\?slug=toko-lambat/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  const next = page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" });
  const address = page.getByLabel("Alamat toko", { exact: true });

  await address.fill("toko-lambat");
  await next.click();
  await address.fill("");
  // At once: the superseded check settles, it is not left to the 3-second safety timeout.
  await expect(page.locator("#slugError")).toHaveText("Alamat toko minimal 3 karakter.", { timeout: 2_000 });
  await expect(page.locator("#stepNow")).toHaveText("1");

  await address.fill("toko-lambat-dua");
  await next.click();
  await address.fill("ab");
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
  // Back on step 1, on the address, which its status now marks unavailable.
  await expect(page.locator("#stepNow")).toHaveText("1");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeFocused();
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini baru saja dipakai.");
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await expect(page.locator("#slugError")).toHaveText("Pilih alamat toko yang tersedia.");
  await expect(page.locator("#stepNow")).toHaveText("1");
  // A suggestion applied by keyboard fills the address and returns focus to the visible field.
  await page.getByRole("button", { name: "toko-tabrakan-baru" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toHaveValue("toko-tabrakan-baru");
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Alamat toko", { exact: true })).toBeFocused();
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await expect(page.locator("#stepNow")).toHaveText("2");
  // What was typed on step 2 before the refusal is still there.
  await expect(page.getByLabel("Nama toko")).toHaveValue("Toko Tabrakan");
});

test("alternatives belong to their address: gone the moment it changes, even when the next check is slow or fails; the server's stay for the same address", async ({ page }) => {
  // The next address's check never answers in time (and then fails).
  await page.route(/\/api\/platform\/slug\?slug=toko-cek-gagal/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.abort("failed");
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  const address = page.getByLabel("Alamat toko", { exact: true });
  await address.fill("admin");
  await expect(page.locator(".sug-chip").first()).toBeVisible();
  await address.fill("toko-cek-gagal");
  await expect(page.locator("#slugSuggestions"), "at once, not when the slow check answers").toBeHidden({ timeout: 300 });
  await expect(page.locator("#slugHint")).toHaveText("Diperiksa saat membuat toko", { timeout: 5_000 });
  await expect(page.locator("#slugSuggestions"), "and still gone after it fails").toBeHidden();
});

test("the server's alternatives for a refused address survive a re-check of that same address", async ({ page }) => {
  let refused = false;
  await page.route(`${PLATFORM}/api/platform/signup`, async (route) => {
    if (refused) return route.continue();
    refused = true;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, error: "Pendaftaran gagal.", errors: { slug: "Alamat toko ini baru saja dipakai." }, suggestions: ["toko-sama-baru"] }) });
  });
  await page.goto(`${PLATFORM}/daftar`);
  await signUpThroughWizard(page, { storeName: "Toko Sama", email: "owner@toko-sama.local.test", password: "password-sama-123" });
  await expect(page.locator("#stepNow")).toHaveText("1");
  await expect(page.getByRole("button", { name: "toko-sama-baru" })).toBeVisible();
  // The same address typed again re-runs the check: still refused, its alternatives kept.
  await page.getByLabel("Alamat toko", { exact: true }).fill("toko-sama");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini baru saja dipakai.");
  await expect(page.getByRole("button", { name: "toko-sama-baru" })).toBeVisible();
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

test("a refusal outranks a late availability answer: the address stays refused and Continue holds", async ({ page }) => {
  test.setTimeout(60_000);
  // This address's availability check answers "available" 4 s late; the server refuses it at once.
  await page.route(/\/api\/platform\/slug\?slug=toko-jawaban-telat/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.continue();
  });
  await page.route(`${PLATFORM}/api/platform/signup`, (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, error: "Pendaftaran gagal.", errors: { slug: "Alamat toko ini baru saja dipakai." }, suggestions: ["toko-jawaban-telat-2"] }) }),
  );
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await page.getByLabel("Alamat toko", { exact: true }).fill("toko-jawaban-telat");
  await expect(page.locator("#slugHint")).toHaveText("Memeriksa…");
  // Continue gives the slow check 3 s, then lets the server decide.
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await expect(page.locator("#stepNow")).toHaveText("2", { timeout: 5_000 });
  await page.getByLabel("Nama toko").fill("Toko Jawaban Telat");
  await page.getByLabel("Email", { exact: true }).fill("owner@jawaban-telat.local.test");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await page.getByLabel("Password", { exact: true }).fill("password-telat-123");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
  await expect(page.locator("#stepNow")).toHaveText("1");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini baru saja dipakai.");
  // The late "available" lands after the refusal and changes nothing.
  await page.waitForTimeout(2_500);
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini baru saja dipakai.");
  await expect(page.locator("#slugHint")).toHaveAttribute("data-state", "err");
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await expect(page.locator("#slugError")).toHaveText("Pilih alamat toko yang tersedia.");
  await expect(page.locator("#stepNow")).toHaveText("1");
});

test("a bot-check refusal at the server is recoverable: retry copy, cleared by a fresh token; other errors stay", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": "198.51.100.123" });
  await withProvider(page, "manual");
  const answers = [
    { error: "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", errors: { turnstile: "Verifikasi gagal." } },
    { error: "Pendaftaran gagal.", errors: { turnstile: "Verifikasi gagal.", password: "Password terlalu mudah ditebak." } },
  ];
  await page.route(`${PLATFORM}/api/platform/signup`, (route) => {
    const answer = answers.shift();
    if (!answer) return route.continue();
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ success: false, ...answer }) });
  });
  const solve = () => page.evaluate(() => (window as unknown as { __fakeTurnstile: { solve(): void } }).__fakeTurnstile.solve());
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve();
  await signUpThroughWizard(page, { storeName: "Toko Token Ditolak", email: "owner@token-ditolak.local.test", password: "password-ditolak-123" });
  // The server's reload instruction becomes a retry: no reload is needed for a fresh token.
  const retry = "Verifikasi keamanan perlu diulang. Tunggu tanda koneksi terverifikasi, lalu tekan Buat Toko Gratis lagi.";
  await expect(page.locator("#turnstileError")).toHaveText(retry);
  await expect(page.locator("#errorSummary")).not.toContainText("Muat ulang");
  await solve();
  await expect(page.locator("#turnstileError")).toBeHidden();
  await expect(page.locator("#errorSummary"), "the summary held only the bot check").toBeHidden();
  // A refusal on the check and on the password: the fresh token clears only its own.
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
  await expect(page.locator("#passwordError")).toHaveText("Password terlalu mudah ditebak.");
  await expect(page.locator("#turnstileError")).toHaveText(retry);
  await solve();
  await expect(page.locator("#turnstileError")).toBeHidden();
  await expect(page.locator("#passwordError")).toHaveText("Password terlalu mudah ditebak.");
  await expect(page.locator("#errorSummary")).toContainText("Password terlalu mudah ditebak.");
  await expect(page.locator("#errorSummary")).not.toContainText("Verifikasi keamanan");
});
