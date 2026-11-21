import { expect, type Page, type Request } from "@playwright/test";
import { PORT } from "../../playwright.config.ts";
import { readVerificationCode, sentVerificationIds } from "../../scripts/dev-mailbox.ts";
import { toSlug } from "../../src/platform/store-finder.ts";

/** The two stores the suite signs up; the owner credentials are dev-seed's fixed local ones. */
export const TENANTS = [
  { slug: "toko-alfa", name: "Toko Alfa" },
  { slug: "toko-beta", name: "Toko Beta" },
] as const;

export const origin = (slug: string) => `http://${slug}.localhost:${PORT}`;
export const PLATFORM = `http://app.localhost:${PORT}`;
export const owner = (slug: string) => ({ username: `owner@${slug}.local.test`, password: "dev-local-password-123" });

/**
 * Wrangler's local email capture (Miniflare's Local Explorer) answers on the dev server's own port, on loopback only.
 * The signup mails a verification code (T-58, PR-11); this is where the suite reads it. Fixture only: see scripts/dev-mailbox.ts.
 */
export const EXPLORER = `http://127.0.0.1:${PORT}`;

/** The signup's first phase ("mail me a code") goes to the same endpoint as the signup itself and is told apart by its `action`. */
export function isCodeRequest(request: Request): boolean {
  try {
    return (request.postDataJSON() as { action?: unknown } | null)?.action === "request_email_code";
  } catch {
    return false;
  }
}

/** The verification mails already captured for `email`. Take it before the click that asks for a new code. */
export const snapshotMailbox = (email: string, explorer = EXPLORER) => sentVerificationIds(explorer, email);

/** The code of the newest verification mail to `email` that is not in `ignore`. Waits for it; never prints it. */
export const codeFromMailbox = (email: string, ignore: ReadonlySet<string>, explorer = EXPLORER) => readVerificationCode(email, { explorer, ignore });

type WizardInput = { storeName: string; slug?: string; email: string; password: string; whatsapp?: string; catalog?: "physical" | "digital" };
export type WizardOptions = {
  /**
   * "final" (default): go on to the code and click "Buat Toko Gratis →". "send-code": stop right after the click on
   * "Kirim kode ke email →", the first call that carries a bot-check token (for a test about that call itself).
   */
  stopAfter?: "send-code" | "final";
  /**
   * Runs on step 4, right before the final click. A test that hands the bot-check token over by hand gives the next one
   * here: the code request spent the first one.
   */
  beforeFinal?: () => Promise<void>;
  explorer?: string;
  /**
   * Type this code instead of reading one from the local capture. ONLY for a test that mocks the server's answers
   * (the code request is fulfilled by the test, nothing is mailed or stored): see `MOCK_CODE_ISSUED`. Never for a
   * signup that reaches the real server, which accepts nothing but the code it mailed.
   */
  code?: string;
};

/** What a mocked server answers to the code request, for tests whose point is how the page handles the signup's own answer. */
export const MOCK_CODE_ISSUED = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ success: true, challenge_id: "mock-challenge-id-not-issued-by-any-server" }),
} as const;
/** A synthetic code for the same tests. The real server would refuse it. */
export const MOCK_CODE = "13572468";

/**
 * Steps 1 to 3 of the wizard up to the password and the terms (not yet sent): step 1 the catalog and the address
 * (`slug`, else the name's own slug), step 2 the store's name and the owner's contact, step 3 security.
 */
async function fillToSecurityStep(page: Page, input: WizardInput) {
  // Typed before the script runs, a value would miss its input handlers.
  await page.waitForFunction(() => (document.getElementById("signupForm") as HTMLFormElement | null)?.dataset.ready === "1");
  if (input.catalog === "digital") await page.getByRole("radio", { name: /Produk Digital/ }).check();
  await page.getByLabel("Alamat toko", { exact: true }).fill(input.slug ?? toSlug(input.storeName));
  await expect(page.locator("#slugHint")).toHaveText("✓ Tersedia", { timeout: 15_000 });
  await page.getByRole("button", { name: "Lanjut ke Nama & Kontak →" }).click();
  await page.getByLabel("Nama toko").fill(input.storeName);
  await page.getByLabel("Email", { exact: true }).fill(input.email);
  if (input.whatsapp) await page.getByLabel("Nomor WhatsApp aktif").fill(input.whatsapp);
  await page.getByRole("button", { name: "Lanjut ke Keamanan →" }).click();
  await page.getByLabel("Password", { exact: true }).fill(input.password);
  await page.getByRole("checkbox").check();
}

/**
 * After a click on "Kirim kode ke email →": waits until the page either shows the code step (returns true) or shows an
 * error instead (returns false: the server refused the code request, for example "email already owns a store").
 * Throws when neither happens within 20 s.
 */
export async function awaitCodeStep(page: Page): Promise<boolean> {
  const codeField = page.getByLabel("Kode verifikasi");
  return Promise.race([
    codeField.waitFor({ state: "visible", timeout: 20_000 }).then(() => true),
    page.locator("#errorSummary:visible, #sendTurnstileError:visible").first().waitFor({ state: "visible", timeout: 20_000 }).then(() => false),
  ]).catch(() => {
    throw new Error('[wizard] neither the code step nor an error appeared within 20 s after "Kirim kode ke email →"');
  });
}

/** Types into the code field the code of the newest verification mail to `email` that is not in `seen`. Waits for the mail. */
export async function typeMailboxCode(page: Page, email: string, seen: ReadonlySet<string>, explorer = EXPLORER): Promise<string> {
  const code = await codeFromMailbox(email, seen, explorer);
  await page.getByLabel("Kode verifikasi").fill(code);
  return code;
}

/**
 * From step 3 with the password and the terms filled: ask for the code, wait for the code step, type the code. Returns
 * true when the code is typed and the caller may click "Buat Toko Gratis →"; false when the server refused the code
 * request, so a test about that refusal can assert it.
 */
export async function requestAndEnterCode(page: Page, email: string, options: Pick<WizardOptions, "explorer" | "code"> = {}): Promise<boolean> {
  const explorer = options.explorer ?? EXPLORER;
  // The capture also holds earlier mails (other runs, other tests): remember what is there before asking for a new one.
  // A test that supplies its own code never touches the capture.
  const seen = options.code === undefined ? await snapshotMailbox(email, explorer) : new Set<string>();
  await page.getByRole("button", { name: "Kirim kode ke email →" }).click();
  if (!(await awaitCodeStep(page))) return false;
  if (options.code !== undefined) await page.getByLabel("Kode verifikasi").fill(options.code);
  else await typeMailboxCode(page, email, seen, explorer);
  return true;
}

/**
 * Signup through the four-step wizard on /daftar, from a page already on it: steps 1 to 3 as `fillToSecurityStep`, then
 * the mailbox proof (T-58): ask for the code, read it from the local capture, type it on step 4. Every real signup in
 * the suite goes through this one gate; there is no way to skip it.
 * Stops at the click on "Buat Toko Gratis →" (after performing it); the caller asserts what follows. When the server
 * refuses the code request it stops there instead, with the refusal on screen.
 */
export async function signUpThroughWizard(page: Page, input: WizardInput, options: WizardOptions = {}) {
  await fillToSecurityStep(page, input);
  if (options.stopAfter === "send-code") {
    await page.getByRole("button", { name: "Kirim kode ke email →" }).click();
    return;
  }
  if (!(await requestAndEnterCode(page, input.email, options))) return;
  await options.beforeFinal?.();
  await page.getByRole("button", { name: "Buat Toko Gratis →" }).click();
}
