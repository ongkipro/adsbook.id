/**
 * Seller signup confirmation (account email, step 1). One transactional
 * message after a signup has fully succeeded; it never gates sign-in, never
 * carries a credential or a login link, and can never change the signup that
 * triggered it.
 *
 * Delivery contract (deliberately small):
 * - **At most once per tenant.** `operator_notices` already is the platform's
 *   claim-before-send table (primary key `(tenant_id, notice)`; purge deletes
 *   its rows), so the claim `seller_signup_email` is reused rather than adding
 *   a table or a migration. The claim is taken before the send and kept
 *   whatever the outcome.
 * - **No retry.** A claim is not provider acceptance, and this table cannot say
 *   whether a claimed send was accepted, rejected or lost. Cloudflare's
 *   `send()` documents no idempotency, so an ambiguous outcome must not be
 *   replayed. Reliable delivery needs a durable outbox (status per message,
 *   provider message id, retry policy) — a schema task for its owner, not
 *   something this module simulates.
 * - **The outcome is returned and logged** (tenant id and a sanitized code only —
 *   never the recipient or the text): `submitted` (`send()` returned; not proof
 *   of delivery), `failed` (a Cloudflare `E_*` code or a malformed-argument
 *   `TypeError`: the call definitely refused), `unknown` (timeout, a network
 *   error such as a string code `ECONNRESET`, or anything that does not say),
 *   `skipped` (no transport bound; nothing is claimed, so enabling the binding
 *   later loses nothing), `duplicate`.
 */

export const SELLER_SIGNUP_EMAIL_CLAIM = "seller_signup_email";
export const SELLER_EMAIL_FROM = "noreply@adsbook.id";
/** The one fixed sign-in door (no per-tenant or caller-supplied origin in a mail). */
export const SELLER_SIGNIN_URL = "https://adsbook.id/masuk";
export const SELLER_EMAIL_TIMEOUT_MS = 8_000;

export type SellerEmailMessage = { to: string; from: string; subject: string; text: string; html: string };
/**
 * Resolves when the provider's `send()` returns (Cloudflare: `{ messageId }`);
 * its docs do not say whether that means accepted for delivery or delivered, so
 * nothing here claims either. Rejects otherwise; a Cloudflare `E_*` code or a
 * `TypeError` (malformed argument) is a definite refusal, anything else is not.
 */
export type EmailTransport = (message: SellerEmailMessage) => Promise<{ messageId?: string } | void>;
export type SellerEmailOutcome = "submitted" | "failed" | "unknown" | "skipped" | "duplicate";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

/** Indonesian text and HTML. No password, no token, no magic link: one fixed sign-in URL. */
export function sellerSignupMessage(to: string, storeName: string): SellerEmailMessage {
  const name = storeName.replace(/[\r\n]+/g, " ").trim().slice(0, 80) || "toko Anda";
  const text = [
    `Halo, toko "${name}" sudah terdaftar di adsbook.id.`,
    "",
    `Masuk ke panel toko dengan email ini dan kata sandi yang Anda buat saat mendaftar: ${SELLER_SIGNIN_URL}`,
    "",
    "Kami tidak pernah meminta kata sandi Anda lewat email. Jika Anda tidak mendaftar, abaikan pesan ini.",
  ].join("\n");
  const html =
    `<p>Halo, toko <strong>${escapeHtml(name)}</strong> sudah terdaftar di adsbook.id.</p>` +
    `<p>Masuk ke panel toko dengan email ini dan kata sandi yang Anda buat saat mendaftar: <a href="${SELLER_SIGNIN_URL}">${SELLER_SIGNIN_URL}</a></p>` +
    "<p>Kami tidak pernah meminta kata sandi Anda lewat email. Jika Anda tidak mendaftar, abaikan pesan ini.</p>";
  return { to, from: SELLER_EMAIL_FROM, subject: "Toko Anda sudah terdaftar di adsbook.id", text, html };
}

/**
 * The Cloudflare `send_email` binding, when the Worker has one named `EMAIL`
 * (the name in Cloudflare's Workers API example; not configured in
 * wrangler.jsonc by this change). Without it there is no transport.
 */
export function emailTransportFromEnv(env: Record<string, unknown> | null | undefined): EmailTransport | null {
  const binding = env?.EMAIL as { send?: (message: SellerEmailMessage) => Promise<{ messageId?: string }> } | undefined;
  return typeof binding?.send === "function" ? (message) => binding.send!(message) : null;
}

/** Cloudflare Email Service codes look like `E_SENDER_NOT_VERIFIED`. Other string codes (Node `ECONNRESET`, `ETIMEDOUT`) say nothing about whether the mail left. */
const PROVIDER_CODE = /^E_[A-Z0-9_]{1,60}$/;
const providerCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && PROVIDER_CODE.test(code) ? code : undefined;
};
const definite = (error: unknown) => error instanceof TypeError || providerCode(error) !== undefined;

/** Never throws: a confirmation must not touch the signup or the tracking around it. */
export async function sendSellerSignupEmail(
  env: Record<string, unknown> | null | undefined,
  platformDb: D1Database,
  tenant: { tenantId: string; email: string; storeName?: string | null },
  transport: EmailTransport | null = emailTransportFromEnv(env),
  now = new Date(),
): Promise<SellerEmailOutcome> {
  if (!transport) {
    console.warn("seller-email-transport-missing", { tenant_id: tenant.tenantId });
    return "skipped";
  }
  try {
    const claimed = await platformDb
      .prepare("INSERT INTO operator_notices (tenant_id, notice, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(tenant.tenantId, SELLER_SIGNUP_EMAIL_CLAIM, now.toISOString())
      .run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) return "duplicate";
  } catch (error) {
    // Nothing was sent and nothing is known to be claimed: the safe answer is not to send.
    console.error("seller-email-claim-failed", { tenant_id: tenant.tenantId, error: error instanceof Error ? error.name : "unknown" });
    return "unknown";
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("seller email send timed out")), SELLER_EMAIL_TIMEOUT_MS);
    });
    try {
      await Promise.race([transport(sellerSignupMessage(tenant.email, tenant.storeName ?? "")), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return "submitted";
  } catch (error) {
    // Only a documented provider code is logged; any other value (free text, a recipient) never is.
    const outcome = definite(error) ? "failed" : "unknown";
    console.error("seller-email-not-submitted", { tenant_id: tenant.tenantId, outcome, code: providerCode(error) });
    return outcome;
  }
}
