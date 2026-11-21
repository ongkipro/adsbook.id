// T-58 / PR-11 UI: the mailbox-code step of /daftar, in a real browser against MOCKED
// answers. Every call to /api/platform/signup is intercepted here and nothing reaches the
// server, so this proves what the page sends and shows, never that the server verifies.
// The server gate is P1's; the page has no bypass of it and this file adds none. The bot
// check is the same in-browser fake the existing auth-studio-safety spec uses (the real
// widget path, api.js replaced), because a fresh token per call is part of the contract.
import { expect, test, type Page } from "@playwright/test";
import { PLATFORM } from "./tenants.ts";

const FAKE_API = `(() => {
  const onload = new URL(document.currentScript.src).searchParams.get("onload");
  const fake = (window.__fakeTurnstile = { renders: 0, resets: 0, options: null, issued: 0 });
  window.turnstile = {
    render(element, options) { fake.renders += 1; fake.options = options; return "fake-widget"; },
    reset() { fake.resets += 1; },
  };
  fake.solve = () => { fake.issued += 1; fake.options.callback("fresh-token-" + fake.issued); };
  window[onload]();
})();`;

type Body = Record<string, unknown>;
type Call = { body: Body; at: number };
type Answer = { status?: number; json: Body } | "abort";

const OK_CHALLENGE = (id: string): Answer => ({ json: { success: true, challenge_id: id } });
const OK_SIGNUP: Answer = { json: { success: true, data: { store_url: "https://toko-uji.adsbook.my.id", login_url: "https://toko-uji.adsbook.my.id/hello", handoff_url: null, handoff_token: null, email: "owner@uji.local.test" } } };
const REFUSED = (error: Body, status = 400): Answer => ({ status, json: { success: false, ...error } });

/** /daftar on the real widget path with the fake provider; every POST to the signup endpoint goes through `reply`. */
async function mockedSignup(page: Page, reply: (call: Call, index: number) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.route(`${PLATFORM}/daftar`, async (route) => {
    const response = await route.fetch();
    const html = (await response.text())
      .replace(/data-standin(="[^"]*")?/, 'data-standin=""')
      .replace(/data-sitekey(="[^"]*")?/, 'data-sitekey="test-site-key"')
      .replace("</form>", '</form><div id="turnstileWidget" class="turnstile-slot"></div>');
    await route.fulfill({ response, body: html });
  });
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: FAKE_API }),
  );
  await page.route(`${PLATFORM}/api/platform/signup`, async (route) => {
    const call: Call = { body: route.request().postDataJSON() as Body, at: Date.now() };
    calls.push(call);
    const answer = await reply(call, calls.length - 1);
    if (answer === "abort") return route.abort("connectionreset");
    return route.fulfill({ status: answer.status ?? 200, contentType: "application/json", body: JSON.stringify(answer.json) });
  });
  return { calls, pageErrors };
}

const ready = (page: Page) => page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
const solve = (page: Page) => page.evaluate(() => (window as unknown as { __fakeTurnstile: { solve(): void } }).__fakeTurnstile.solve());
const fake = (page: Page) => page.evaluate(() => (window as unknown as { __fakeTurnstile: { resets: number; renders: number; issued: number } }).__fakeTurnstile);

const STORE = { storeName: "Toko Uji Kode", slug: "toko-uji-kode", email: "Owner@Uji.Local.Test", password: "password-uji-123" };

/** Steps 1 to 3 with the page's own controls, up to (not including) the click on "Kirim kode ke email →". */
async function toSecurityStep(page: Page, store = STORE) {
  await page.getByLabel("Alamat toko", { exact: true }).fill(store.slug);
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await page.getByLabel("Nama toko").fill(store.storeName);
  await page.getByLabel("Email", { exact: true }).fill(store.email);
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await page.getByLabel("Password", { exact: true }).fill(store.password);
  await page.getByRole("checkbox").check();
}

const sendButton = (page: Page) => page.getByRole("button", { name: "Kirim kode ke email →" });
const createButton = (page: Page) => page.getByRole("button", { name: "Buat Toko Gratis →" });
const codeField = (page: Page) => page.getByLabel("Kode verifikasi");

/** A fresh token for the next call: the page reset the widget, the (fake) provider hands out another. */
async function freshToken(page: Page, resetsAtLeast: number) {
  await expect.poll(async () => (await fake(page)).resets).toBeGreaterThanOrEqual(resetsAtLeast);
  await solve(page);
  await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "ok");
}

test("send the code, then sign up: two calls, the exact payloads, a fresh token each, the code never leaves memory", async ({ page }) => {
  const { calls, pageErrors } = await mockedSignup(page, (_call, index) => (index === 0 ? OK_CHALLENGE("chal-opaque-1") : OK_SIGNUP));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);

  // Step 3 holds the password and the terms; the button names what it does and nothing is created yet.
  await expect(page.locator("#stepNow")).toHaveText("3");
  await expect(page.locator(".step-count")).toContainText("/ 4");
  await sendButton(page).click();

  // Step 4: the code field, focused, labelled, one-time-code, numeric, naming the address it went to.
  await expect(page.locator("#stepNow")).toHaveText("4");
  await expect(codeField(page)).toBeFocused();
  await expect(codeField(page)).toHaveAttribute("autocomplete", "one-time-code");
  await expect(codeField(page)).toHaveAttribute("inputmode", "numeric");
  // The address is shown as the seller typed it (the server binds to its normalised form).
  await expect(page.locator("#codeHint")).toContainText("Owner@Uji.Local.Test");
  await expect(page.locator("#codeHint")).toContainText("10 menit");
  expect(calls, "only the code request so far").toHaveLength(1);
  expect(calls[0].body, "the request payload is exactly these keys").toEqual({ action: "request_email_code", email: STORE.email, turnstile_token: "fresh-token-1" });

  // Before a request is spent on it, a malformed code is refused on the screen.
  await createButton(page).click();
  await expect(page.locator("#emailCodeError")).toHaveText("Masukkan 8 angka kode dari email.");
  await expect(codeField(page)).toHaveAttribute("aria-invalid", "true");
  expect(calls, "no request for a malformed code").toHaveLength(1);

  // A token is single use: the first one is spent, the widget was reset, and the second call waits for a fresh one.
  await freshToken(page, 1);
  await codeField(page).fill("1234 5678");
  await expect(codeField(page), "digits only, a pasted space is dropped").toHaveValue("12345678");
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].body).toEqual({
    store_name: STORE.storeName,
    slug: STORE.slug,
    email: STORE.email,
    whatsapp: "",
    password: STORE.password,
    terms: true,
    catalog_mode: "physical",
    turnstile_token: "fresh-token-2",
    event_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    challenge_id: "chal-opaque-1",
    email_code: "12345678",
  });
  expect("action" in calls[1].body, "the final request is not an action request").toBe(false);
  expect(calls[1].body.turnstile_token, "a new token, not the one the code request spent").not.toBe(calls[0].body.turnstile_token);
  await expect(page.locator("#signupDone")).toBeVisible();
  // The spent code does not stay in its field (the handle itself is a private variable: not observable from the page).
  await expect(page.locator("#emailCode"), "the spent code is cleared from the field").toHaveValue("");

  // Nothing of the verification is written anywhere the page can be resumed from.
  const kept = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
    url: location.href,
    attributes: [...document.querySelectorAll("*")].flatMap((element) => [...element.attributes].map((attribute) => attribute.value)).join("\n"),
  }));
  for (const [where, text] of Object.entries(kept)) {
    expect(text, `challenge id in ${where}`).not.toContain("chal-opaque-1");
    expect(text, `code in ${where}`).not.toContain("12345678");
  }
  expect(pageErrors).toEqual([]);
});

test("a wrong email is corrected: the old code is dropped, a new one is sent for the new address, the old handle never rides along", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => (index === 0 ? OK_CHALLENGE("chal-for-old") : index === 1 ? OK_CHALLENGE("chal-for-new") : OK_SIGNUP));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page, { ...STORE, email: "salah@uji.local.test" });
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  await codeField(page).fill("11112222");

  await page.getByRole("button", { name: "Ganti email" }).click();
  await expect(page.locator("#stepNow")).toHaveText("2");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await page.getByLabel("Email", { exact: true }).fill("benar@uji.local.test");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(STORE.password);

  await freshToken(page, 1);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "a new code request for the new address").toHaveLength(2);
  expect(calls[1].body).toMatchObject({ action: "request_email_code", email: "benar@uji.local.test" });
  await expect(codeField(page), "typed digits for the old address are gone").toHaveValue("");
  await expect(page.locator("#codeHint")).toContainText("benar@uji.local.test");
  await expect(page.locator("#codeHint")).not.toContainText("salah@");

  await freshToken(page, 2);
  await codeField(page).fill("33334444");
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(3);
  expect(calls[2].body).toMatchObject({ email: "benar@uji.local.test", challenge_id: "chal-for-new", email_code: "33334444" });
  expect(JSON.stringify(calls[2].body)).not.toContain("chal-for-old");
});

test("editing the email on step 2 drops the held code; going back and forth with the same address keeps it", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => OK_CHALLENGE(`chal-${index + 1}`));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");

  // Same address, a round trip: no second code is mailed.
  await page.getByRole("button", { name: "← Kembali" }).click();
  await page.getByRole("button", { name: "← Kembali" }).click();
  await expect(page.locator("#stepNow")).toHaveText("2");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "the held code is reused, nothing is re-sent").toHaveLength(1);

  // Same address in other letters: still the same mailbox, still the same code.
  await page.getByRole("button", { name: "Ganti email" }).click();
  await page.getByLabel("Email", { exact: true }).fill("OWNER@UJI.LOCAL.TEST");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "a case change is not a new address").toHaveLength(1);

  // A different address: the next send is a new request.
  await page.getByRole("button", { name: "Ganti email" }).click();
  await page.getByLabel("Email", { exact: true }).fill("lain@uji.local.test");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await freshToken(page, 1);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls).toHaveLength(2);
});

test("resend: a cooldown, a fresh token, a new challenge replaces the old one, and the server's refusal keeps the old code usable", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-21T00:00:00Z") });
  const { calls } = await mockedSignup(page, (_call, index) => {
    if (index === 0) return OK_CHALLENGE("chal-first");
    if (index === 1) return REFUSED({ error: "Terlalu banyak permintaan kode. Coba lagi nanti." }, 429);
    if (index === 2) return OK_CHALLENGE("chal-second");
    return OK_SIGNUP;
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");

  const resend = page.getByRole("button", { name: "Kirim ulang kode" });
  await expect(resend).toBeDisabled();
  await expect(page.locator("#resendWait")).toContainText("detik");
  await page.clock.fastForward(59_000);
  await expect(resend).toBeDisabled();
  await page.clock.fastForward(2_000);
  await expect(resend).toBeEnabled();
  await expect(page.locator("#resendWait")).toHaveText("");

  // The server refuses a resend: its words are shown, the code already held still works, and the cooldown restarts.
  await freshToken(page, 1);
  await resend.click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].body).toEqual({ action: "request_email_code", email: STORE.email, turnstile_token: "fresh-token-2" });
  await expect(page.locator("#errorSummary")).toContainText("Terlalu banyak permintaan kode.");
  await expect(page.locator("#stepNow")).toHaveText("4");

  // A resend that works replaces the challenge: the final request carries the newest id and says so on screen.
  await page.clock.fastForward(61_000);
  await freshToken(page, 2);
  await resend.click();
  await expect.poll(() => calls.length).toBe(3);
  await expect(page.locator("#codeNote")).toContainText("Kode baru sudah dikirim");
  await expect(page.locator("#errorSummary")).toBeHidden();
  await freshToken(page, 3);
  await codeField(page).fill("99990000");
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(4);
  expect(calls[3].body).toMatchObject({ challenge_id: "chal-second", email_code: "99990000" });
});

test("server refusals of the code keep the wizard on step 4 and the digits editable; a lost answer spends the token", async ({ page }) => {
  const refusals: Body[] = [
    { error: "Pendaftaran gagal.", errors: { emailCode: "Kode salah. Periksa lagi atau kirim ulang." } },
    { error: "Pendaftaran gagal.", errors: { emailCode: "Kode sudah kedaluwarsa. Kirim ulang kode." } },
  ];
  const { calls, pageErrors } = await mockedSignup(page, (_call, index) => {
    if (index === 0) return OK_CHALLENGE("chal-keep");
    const refusal = refusals.shift();
    if (refusal) return REFUSED(refusal);
    if (index === 3) return "abort";
    return OK_SIGNUP;
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");

  await freshToken(page, 1);
  await codeField(page).fill("00000000");
  await createButton(page).click();
  await expect(page.locator("#emailCodeError")).toHaveText("Kode salah. Periksa lagi atau kirim ulang.");
  await expect(page.locator("#stepNow"), "no jump back to another step").toHaveText("4");
  await expect(codeField(page)).toBeFocused();
  await expect(codeField(page), "the typed digits stay for correction").toHaveValue("00000000");
  await expect(createButton(page)).toBeEnabled();
  await expect(page.locator("#errorSummary")).toContainText("Kode salah");

  // Typing clears the field's error; the bot-check token was spent by the refused call and the widget was reset.
  await codeField(page).fill("1");
  await expect(page.locator("#emailCodeError")).toBeHidden();
  expect((await fake(page)).resets).toBeGreaterThanOrEqual(2);
  await freshToken(page, 2);
  await codeField(page).fill("11111111");
  await createButton(page).click();
  await expect(page.locator("#emailCodeError")).toHaveText("Kode sudah kedaluwarsa. Kirim ulang kode.");
  expect(calls[2].body.challenge_id, "the same handle is sent until the server says otherwise").toBe("chal-keep");

  // A lost answer: the call may have been spent server-side, so the page waits for a fresh token before another send.
  await freshToken(page, 3);
  await codeField(page).fill("22222222");
  await createButton(page).click();
  await expect(page.locator("#errorSummary")).toContainText("Koneksi terputus");
  await expect.poll(() => calls.length).toBe(4);
  await expect(page.locator("#securityStatus")).toHaveAttribute("data-state", "pending");
  await createButton(page).click();
  await expect(createButton(page).or(page.getByRole("button", { name: "Menyelesaikan verifikasi keamanan…" }))).toBeVisible();
  await page.waitForTimeout(300);
  expect(calls, "the spent token is never resent").toHaveLength(4);
  await freshToken(page, 4);
  await expect.poll(() => calls.length).toBe(5);
  expect(pageErrors).toEqual([]);
});

test("a send that fails keeps the seller on step 3 with the form intact; the server's field errors send them to their step", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => {
    if (index === 0) return REFUSED({ error: "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", errors: { turnstile: "Verifikasi gagal." } });
    if (index === 1) return REFUSED({ error: "Email ini sudah terdaftar untuk sebuah toko. Silakan masuk, atau gunakan email lain.", errors: { email: "Email ini sudah terdaftar untuk sebuah toko. Silakan masuk, atau gunakan email lain." } }, 409);
    if (index === 2) return { json: { success: true } }; // success without a challenge id is not a success
    return OK_CHALLENGE("chal-late");
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);

  await sendButton(page).click();
  await expect(page.locator("#turnstileError, #sendTurnstileError").filter({ hasText: "Verifikasi keamanan perlu diulang" }).first()).toBeVisible();
  await expect(page.locator("#sendTurnstileError")).toContainText("lalu tekan Kirim kode ke email lagi.");
  await expect(page.locator("#stepNow")).toHaveText("3");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(STORE.password);
  await expect(page.getByRole("checkbox")).toBeChecked();

  await freshToken(page, 1);
  await expect(page.locator("#sendTurnstileError")).toBeHidden();
  await sendButton(page).click();
  await expect(page.locator("#emailError")).toContainText("Email ini sudah terdaftar");
  await expect(page.locator("#stepNow"), "an email refusal returns to the step that holds the email").toHaveText("2");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();

  await page.getByLabel("Email", { exact: true }).fill("baru@uji.local.test");
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await freshToken(page, 2);
  await sendButton(page).click();
  await expect(page.locator("#errorSummary")).toContainText("Kode belum bisa dikirim");
  await expect(page.locator("#stepNow"), "no code step without a challenge id").toHaveText("3");
  await freshToken(page, 3);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls).toHaveLength(4);
});

test("step 3 checks the password and the terms on the screen before a code is mailed", async ({ page }) => {
  const { calls } = await mockedSignup(page, () => OK_CHALLENGE("chal-never"));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page, { ...STORE, password: "pendek" });
  await sendButton(page).click();
  await expect(page.locator("#passwordError")).toHaveText("Password 10–128 karakter.");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();

  await page.getByLabel("Password", { exact: true }).fill(STORE.email);
  await sendButton(page).click();
  await expect(page.locator("#passwordError")).toHaveText("Password tidak boleh sama dengan email.");

  await page.getByLabel("Password", { exact: true }).fill(STORE.password);
  await page.getByRole("checkbox").uncheck();
  await sendButton(page).click();
  await expect(page.locator("#termsError")).toHaveText("Setujui syarat & ketentuan untuk melanjutkan.");
  expect(calls, "a refusal the page can see never costs a code").toHaveLength(0);
  await expect(page.locator("#stepNow")).toHaveText("3");
});

test("no token, no request: the code request waits for the bot check and says so", async ({ page }) => {
  const { calls } = await mockedSignup(page, () => OK_CHALLENGE("chal-late-token"));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.getByRole("status")).toHaveText("Menyelesaikan verifikasi keamanan…");
  await expect(page.locator("#sendTurnstileError")).toContainText("Verifikasi keamanan belum selesai", { timeout: 8_000 });
  await expect(page.locator("#sendTurnstileError")).toContainText("lalu tekan Kirim kode ke email lagi.");
  expect(calls, "nothing is sent without a token").toHaveLength(0);
  await expect(sendButton(page)).toBeEnabled();
  await expect(sendButton(page), "focus returns to the button").toBeFocused();
  await solve(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls[0].body).toMatchObject({ action: "request_email_code", turnstile_token: "fresh-token-1" });
});

test("keyboard: a whole signup with Tab, Enter and typing, and no unnamed control on the new step", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => (index === 0 ? OK_CHALLENGE("chal-keys") : OK_SIGNUP));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await page.getByLabel("Password", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#stepNow")).toHaveText("4");
  await expect(codeField(page)).toBeFocused();
  await freshToken(page, 1);
  await page.keyboard.type("24681357");
  await page.keyboard.press("Enter");
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].body).toMatchObject({ challenge_id: "chal-keys", email_code: "24681357" });

  // The step's controls all have names (checked on a fresh page so the launch screen is not in the way).
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  const unnamed = await page.locator('[data-step-panel="4"] :is(input, button):visible').evaluateAll((elements) =>
    elements.filter((element) => !(element.getAttribute("aria-label") || (element as HTMLInputElement).labels?.length || element.textContent?.trim())).length,
  );
  expect(unnamed).toBe(0);
});

test("a refusal about the store sends the seller back and the code is not offered again: the next send mails a new one, and only its handle rides along", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => {
    if (index === 0) return OK_CHALLENGE("chal-A");
    if (index === 1) return REFUSED({ error: "Pendaftaran gagal.", errors: { slug: "Alamat toko ini sudah dipakai." }, suggestions: [] }, 409);
    if (index === 2) return OK_CHALLENGE("chal-B");
    return OK_SIGNUP;
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  await freshToken(page, 1);
  await codeField(page).fill("11112222");
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].body).toMatchObject({ challenge_id: "chal-A", email_code: "11112222" });

  // The wizard returns to the address. The server may already have spent the code by now, so the page drops it.
  await expect(page.locator("#stepNow")).toHaveText("1");
  await expect(page.locator("#slugHint")).toHaveText("Alamat toko ini sudah dipakai.");
  await page.getByLabel("Alamat toko", { exact: true }).fill("toko-uji-kode-dua");
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await freshToken(page, 2);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "a new code request, not a reuse of the old handle").toHaveLength(3);
  expect(calls[2].body).toMatchObject({ action: "request_email_code", email: STORE.email });
  await expect(codeField(page), "the digits typed for the dropped code are gone").toHaveValue("");

  await freshToken(page, 3);
  await codeField(page).fill("33334444");
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(4);
  expect(calls[3].body).toMatchObject({ slug: "toko-uji-kode-dua", challenge_id: "chal-B", email_code: "33334444" });
  expect(JSON.stringify(calls[3].body)).not.toContain("chal-A");
});

test("a bot-check refusal on the final call keeps the seller on step 4 with the same code; a fresh token sends it again", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => {
    if (index === 0) return OK_CHALLENGE("chal-T");
    if (index === 1) return REFUSED({ error: "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", errors: { turnstile: "Verifikasi gagal." } });
    return OK_SIGNUP;
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  await freshToken(page, 1);
  await codeField(page).fill("55556666");
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(2);

  await expect(page.locator("#turnstileError")).toHaveText("Verifikasi keamanan perlu diulang. Tunggu tanda koneksi terverifikasi, lalu tekan Buat Toko Gratis lagi.");
  // As on the old final call (auth-studio-safety): the banner repeats the retry copy, never the server's reload instruction.
  await expect(page.locator("#errorSummary")).not.toContainText("Muat ulang");
  await expect(page.locator("#stepNow")).toHaveText("4");
  await expect(codeField(page)).toHaveValue("55556666");
  await freshToken(page, 2);
  await expect(page.locator("#turnstileError")).toBeHidden();
  await expect(page.locator("#errorSummary"), "it held only the bot check, so a fresh token clears it").toBeHidden();
  await createButton(page).click();
  await expect.poll(() => calls.length).toBe(3);
  expect(calls[2].body).toMatchObject({ challenge_id: "chal-T", email_code: "55556666", turnstile_token: "fresh-token-3" });
});

test("a double click sends once: one code request, one signup", async ({ page }) => {
  const { calls } = await mockedSignup(page, async (_call, index) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return index === 0 ? OK_CHALLENGE("chal-dbl") : OK_SIGNUP;
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).dblclick();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "one code request for two clicks").toHaveLength(1);
  await freshToken(page, 1);
  await codeField(page).fill("77778888");
  await createButton(page).dblclick();
  await expect(page.locator("#signupDone")).toBeVisible();
  expect(calls, "one signup for two clicks").toHaveLength(2);
});

test("a reload forgets the code: the wizard starts over and the next send mails a new one", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => OK_CHALLENGE(`chal-load-${index + 1}`));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  await codeField(page).fill("12121212");

  await page.reload();
  await ready(page);
  await expect(page.locator("#stepNow")).toHaveText("1");
  await expect(codeField(page)).toHaveValue("");
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "nothing was resumed: a second code request").toHaveLength(2);
  expect(calls[1].body).toMatchObject({ action: "request_email_code" });
});

test("the digits typed for one address do not survive an edit of it, and typing the old address back does not revive the old code", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => OK_CHALLENGE(`chal-${index + 1}`));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  await codeField(page).fill("11112222");

  await page.getByRole("button", { name: "Ganti email" }).click();
  await page.getByLabel("Email", { exact: true }).fill("lain@uji.local.test");
  await expect(codeField(page), "digits typed for the old address are gone the moment it is edited").toHaveValue("");

  // Back to the first address: the code mailed for it is not offered again; the next send is a new request.
  await page.getByLabel("Email", { exact: true }).fill(STORE.email);
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await freshToken(page, 1);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "a dropped code is not revived by typing the old address again").toHaveLength(2);
  expect(calls[1].body).toMatchObject({ action: "request_email_code", email: STORE.email });
});

test("the held code is bound to the address where it is used: a field changed without an input event never sends or reuses it", async ({ page }) => {
  const { calls } = await mockedSignup(page, (_call, index) => OK_CHALLENGE(index === 0 ? "chal-bound" : "chal-rebound"));
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  await codeField(page).fill("12345678");

  // A password manager, a script or an extension can set a field without an input event, so the page's own
  // "address edited" handler never runs. The binding is checked again at the point of use.
  await page.evaluate(() => {
    (document.getElementById("email") as HTMLInputElement).value = "tukar@uji.local.test";
  });
  await freshToken(page, 1);
  await createButton(page).click();
  await expect(page.locator("#emailCodeError")).toHaveText("Kode belum dikirim untuk email ini. Kirim kode dulu.");
  expect(calls, "nothing is sent for an address the code was not mailed to").toHaveLength(1);

  // Step 3 does not reuse it either: the next send is a new request, for the new address.
  await page.getByRole("button", { name: "← Kembali" }).click();
  await sendButton(page).click();
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "the code for the old address is not reused").toHaveLength(2);
  expect(calls[1].body).toMatchObject({ action: "request_email_code", email: "tukar@uji.local.test" });
});

test("a second submit while a call is open is ignored: two submit events in one task send once, on step 3 and on step 4", async ({ page }) => {
  const { calls } = await mockedSignup(page, async (_call, index) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return index === 0 ? OK_CHALLENGE("chal-twice") : OK_SIGNUP;
  });
  await page.goto(`${PLATFORM}/daftar`);
  await ready(page);
  await solve(page);
  await toSecurityStep(page);
  // Two submit events dispatched in the same task: no click, no disabled or inert button can stop the second one.
  await page.evaluate(() => {
    const form = document.getElementById("signupForm") as HTMLFormElement;
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.locator("#stepNow")).toHaveText("4");
  expect(calls, "one code request for two submit events").toHaveLength(1);

  await freshToken(page, 1);
  await codeField(page).fill("13572468");
  await page.evaluate(() => {
    const form = document.getElementById("signupForm") as HTMLFormElement;
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.locator("#signupDone")).toBeVisible();
  expect(calls, "one signup for two submit events").toHaveLength(2);
});

for (const [width, height] of [[390, 844], [1366, 768]] as const) {
  test(`layout at ${width}x${height}: steps 3 and 4 fit one screen, the code field is 20px (no iOS zoom), nothing overflows sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mockedSignup(page, () => OK_CHALLENGE("chal-layout"));
    await page.goto(`${PLATFORM}/daftar`);
    await ready(page);
    await solve(page);
    await toSecurityStep(page, { ...STORE, email: "pemilik-dengan-alamat-email-yang-cukup-panjang@contoh-domain-panjang.local.test" });
    const fits = async (label: string) => {
      await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished)));
      const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: window.innerWidth, h: document.documentElement.scrollHeight, vh: window.innerHeight }));
      expect(size.w, `${label}: no horizontal scroll`).toBeLessThanOrEqual(size.vw);
      expect(size.h, `${label}: fits the screen without vertical scroll`).toBeLessThanOrEqual(size.vh);
    };
    await fits("step 3");
    if (process.env.T58_SHOT_DIR) await page.screenshot({ path: `${process.env.T58_SHOT_DIR}/t58-step3-${width}.png` });
    await sendButton(page).click();
    await expect(page.locator("#stepNow")).toHaveText("4");
    await fits("step 4");
    await expect(codeField(page)).toHaveCSS("font-size", "20px");
    for (const control of [codeField(page), createButton(page), page.getByRole("button", { name: "Ganti email" })]) {
      const box = await control.boundingBox();
      expect(box!.height, "touch target height").toBeGreaterThanOrEqual(36);
      expect(box!.x + box!.width, "inside the viewport").toBeLessThanOrEqual(width);
    }
    if (process.env.T58_SHOT_DIR) await page.screenshot({ path: `${process.env.T58_SHOT_DIR}/t58-step4-${width}.png` });
  });
}
