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

/** adsbook.id brand values (docs/design/DESIGN-SYSTEM.md §1): white canvas, slate ink, brand blue. Inline in the mail because clients drop <style>. */
const INK = "#0f172a";
const MUTED = "#475569";
const BLUE = "#2563eb";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BUTTON_LABEL = "Masuk ke Panel Toko";
const SUBJECT = "Toko Anda sudah terdaftar di adsbook.id";

const LEAD = "sudah dibuat di adsbook.id.";
const NEXT =
  "Langkah berikutnya: masuk ke panel toko dengan alamat email dan kata sandi yang Anda buat saat mendaftar, lalu lengkapi pengaturan toko Anda.";
const SECURITY = "Kami tidak pernah meminta kata sandi Anda lewat email. Jika Anda tidak mendaftar di adsbook.id, abaikan pesan ini.";
const AUTOMATIC = "Email ini dikirim otomatis dan tidak menerima balasan.";

/**
 * Branded signup confirmation, Indonesian. Plain text and HTML carry the same
 * sentences. It says a store was created and what to do next; it does not say
 * the address is verified, that the store can sell, or that a reply reaches
 * anyone. One button to the fixed sign-in URL; no image, tracking, password,
 * token or automatic sign-in. The wordmark is text (clients block remote
 * images and most do not render SVG), so it is also the image-blocked fallback.
 */
export function sellerSignupMessage(to: string, storeName: string): SellerEmailMessage {
  const name = storeName.replace(/[\r\n\u2028\u2029]+/g, " ").trim().slice(0, 80) || "toko Anda";
  const text = [
    "Toko Anda sudah terdaftar",
    "",
    `Halo, toko "${name}" ${LEAD}`,
    "",
    NEXT,
    "",
    `${BUTTON_LABEL}: ${SELLER_SIGNIN_URL}`,
    "",
    SECURITY,
    AUTOMATIC,
  ].join("\n");
  const safe = escapeHtml(name);
  const cell = (style: string, inner: string) => `<tr><td style="${style}">${inner}</td></tr>`;
  const body = `font-family:${FONT};font-size:16px;line-height:24px;color:${INK};padding:0 24px 16px 24px;overflow-wrap:anywhere;word-wrap:break-word;word-break:break-word;`;
  const html =
    `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(SUBJECT)}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff;">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">Toko ${safe} ${LEAD} Masuk ke panel toko untuk memulai.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;"><tr><td align="center" style="padding:0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;">` +
    `<tr><td height="4" style="height:4px;line-height:4px;font-size:4px;background:${BLUE};" bgcolor="${BLUE}">&nbsp;</td></tr>` +
    cell(`font-family:${FONT};font-size:28px;line-height:32px;font-weight:700;letter-spacing:-0.02em;color:${INK};padding:28px 24px 20px 24px;`, `adsbook<span style="color:${BLUE};">.</span>id`) +
    cell(`font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${INK};padding:0 24px 12px 24px;`, "Toko Anda sudah terdaftar") +
    cell(body, `Halo, toko <strong>${safe}</strong> ${LEAD}`) +
    cell(body, NEXT) +
    `<tr><td style="padding:8px 24px 20px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td align="center" bgcolor="${BLUE}" style="background:${BLUE};border-radius:8px;">` +
    `<a href="${SELLER_SIGNIN_URL}" style="display:inline-block;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;min-height:20px;border-radius:8px;">${BUTTON_LABEL}</a>` +
    `</td></tr></table></td></tr>` +
    cell(`font-family:${FONT};font-size:14px;line-height:20px;color:${MUTED};padding:0 24px 20px 24px;`, `Tombol tidak berfungsi? Salin alamat ini ke browser: ${SELLER_SIGNIN_URL}`) +
    cell(`font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};padding:16px 24px 32px 24px;border-top:1px solid #e2e8f0;`, `${SECURITY}<br>${AUTOMATIC}`) +
    `</table></td></tr></table></body></html>`;
  return { to, from: SELLER_EMAIL_FROM, subject: SUBJECT, text, html };
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
