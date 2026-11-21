/**
 * T-58 / PR-11: the mailbox proof every seller signup needs before a tenant
 * is reserved. Phase one (`action: "request_email_code"`) mails an 8-digit
 * code to the exact address and answers an opaque challenge id; phase two
 * (the existing signup request) carries `challenge_id` and `email_code`, and
 * the challenge is consumed **in the same D1 batch** that reserves the tenant
 * (`challengeClaim`): a wrong code reserves nothing, a taken slug rolls the
 * consumption back, and of two concurrent claims exactly one reserves.
 *
 * What is stored (`signup_email_challenges`, migration 0011): the SHA-256 of the
 * challenge id, a keyed digest of the email and a keyed digest of the code
 * bound to that id and email. Never the code, never the address, never the id.
 * The key is HKDF-SHA-256 of the platform Worker secret with this module's own
 * `info`, so it is separate from every other use of that secret. No secret:
 * no code is issued and no signup passes (fail closed). There is no bypass:
 * an offline or test transport goes through the same issue and claim.
 */
import { SELLER_EMAIL_FROM, type EmailTransport, type SellerEmailMessage } from "./seller-email.ts";

export const SIGNUP_CODE_TTL_MS = 10 * 60 * 1000;
export const SIGNUP_CODE_MAX_ATTEMPTS = 5;
/** Codes per address per hour, failed sends included, and the gap between two of them. */
export const SIGNUP_CODE_SENDS_PER_HOUR = 3;
export const SIGNUP_CODE_RESEND_GAP_MS = 60 * 1000;
/** Code requests per network address per hour (the signup itself keeps its own limit). */
export const SIGNUP_CODE_REQUESTS_PER_IP_PER_HOUR = 10;
export const SIGNUP_CODE_SEND_TIMEOUT_MS = 8_000;

const HOUR_MS = 60 * 60 * 1000;
const KEY_INFO = "adsbook.id/signup-email-verification/v1";
const CHALLENGE_ID = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_CODE = /^[0-9]{8}$/;

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const utf8 = (value: string) => new TextEncoder().encode(value);

export const isChallengeId = (value: unknown): value is string => typeof value === "string" && CHALLENGE_ID.test(value);
export const isEmailCode = (value: unknown): value is string => typeof value === "string" && EMAIL_CODE.test(value);

/** The keyed digest's key, or null when the platform secret is missing or short (closed). */
export async function verificationKey(env: Record<string, unknown> | null | undefined): Promise<CryptoKey | null> {
  const secret = typeof env?.PLATFORM_AUTH_SECRET === "string" ? env.PLATFORM_AUTH_SECRET : "";
  if (secret.length < 32) return null;
  const root = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(KEY_INFO) },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

/** Each purpose is its own label, and NUL separates fields that cannot contain it. */
async function mac(key: CryptoKey, purpose: "email" | "code", ...fields: string[]): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", key, utf8([purpose, ...fields].join("\0"))));
}

export const emailDigest = (key: CryptoKey, email: string) => mac(key, "email", email);
export const codeDigest = (key: CryptoKey, challengeId: string, email: string, code: string) => mac(key, "code", challengeId, email, code);
export const challengeHash = async (challengeId: string) => hex(await crypto.subtle.digest("SHA-256", utf8(challengeId)));

/** 256 random bits, base64url (43 characters). */
export function newChallengeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Eight uniform ASCII digits (rejection sampling: no modulo bias). */
export function newEmailCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 100_000_000) * 100_000_000;
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 100_000_000).padStart(8, "0");
  }
}

/**
 * Inserts a challenge only while the address is under its hourly cap and past
 * the resend gap, in one statement (no read-then-write race). `changes = 0`
 * means refused.
 */
export function insertChallenge(
  db: D1Database,
  row: { idHash: string; emailDigest: string; codeDigest: string; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO signup_email_challenges (challenge_id_hash, email_digest, code_digest, state, attempts, created_at, expires_at)
       SELECT ?, ?, ?, 'issued', 0, ?, ?
       WHERE (SELECT COUNT(*) FROM signup_email_challenges WHERE email_digest = ? AND created_at > ?) < ?
         AND NOT EXISTS (SELECT 1 FROM signup_email_challenges WHERE email_digest = ? AND created_at > ?)`,
    )
    .bind(
      row.idHash, row.emailDigest, row.codeDigest, row.now, row.now + SIGNUP_CODE_TTL_MS,
      row.emailDigest, row.now - HOUR_MS, SIGNUP_CODE_SENDS_PER_HOUR,
      row.emailDigest, row.now - SIGNUP_CODE_RESEND_GAP_MS,
    );
}

/** After the send returned: this challenge becomes claimable and every older one for the address is void. */
export function markChallengeSent(db: D1Database, idHash: string, emailDigestValue: string): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE signup_email_challenges SET state = 'sent' WHERE challenge_id_hash = ? AND state = 'issued'").bind(idHash),
    db
      .prepare(
        `UPDATE signup_email_challenges SET state = 'superseded'
         WHERE email_digest = ? AND challenge_id_hash <> ? AND state IN ('issued', 'sent')
           AND EXISTS (SELECT 1 FROM signup_email_challenges WHERE challenge_id_hash = ? AND state = 'sent')`,
      )
      .bind(emailDigestValue, idHash, idHash),
  ];
}

/**
 * Retention (PRIV-4 style, run by the hourly platform job): a challenge row is
 * kept while it can still count toward its address's hourly send cap, then
 * deleted, oldest first, at most `limit` rows per run. Its code expired long
 * before (TTL 10 min < 1 h), and a deleted id can no longer be claimed, so a
 * replay after deletion is refused like an unknown id. `expires_at` is
 * `created_at + TTL` for every row, so the range scan uses the expiry index and
 * `created_at` keeps the cap's own window exact.
 */
export function deleteRetiredChallenges(db: D1Database, now: number, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM signup_email_challenges WHERE challenge_id_hash IN (
         SELECT challenge_id_hash FROM signup_email_challenges
         WHERE expires_at <= ? AND created_at <= ? ORDER BY expires_at LIMIT ?)`,
    )
    .bind(now - HOUR_MS + SIGNUP_CODE_TTL_MS, now - HOUR_MS, limit);
}

export const voidChallenge = (db: D1Database, idHash: string) =>
  db.prepare("UPDATE signup_email_challenges SET state = 'void' WHERE challenge_id_hash = ? AND state = 'issued'").bind(idHash);

/**
 * The claim, for the reservation batch. `consume` is the batch's first
 * statement: one attempt is spent on a live, sent challenge of this exact
 * address; the right code marks it consumed **by this request's nonce**, the
 * last allowed wrong code exhausts it. `guard` is the predicate every
 * reservation insert carries, so they write only when this request won.
 */
export async function challengeClaim(
  db: D1Database,
  key: CryptoKey,
  proof: { challengeId: string; email: string; code: string; now: number },
): Promise<{ consume: D1PreparedStatement; guard: string; guardBinds: string[] }> {
  const idHash = await challengeHash(proof.challengeId);
  const presented = await codeDigest(key, proof.challengeId, proof.email, proof.code);
  const nonce = newChallengeId();
  const consume = db
    .prepare(
      `UPDATE signup_email_challenges
       SET attempts = attempts + 1,
           state = CASE WHEN code_digest = ? THEN 'consumed' WHEN attempts + 1 >= ? THEN 'exhausted' ELSE state END,
           consumed_by = CASE WHEN code_digest = ? THEN ? ELSE NULL END,
           consumed_at = CASE WHEN code_digest = ? THEN ? ELSE NULL END
       WHERE challenge_id_hash = ? AND email_digest = ? AND state = 'sent' AND expires_at > ? AND attempts < ?`,
    )
    .bind(
      presented, SIGNUP_CODE_MAX_ATTEMPTS, presented, nonce, presented, proof.now,
      idHash, await emailDigest(key, proof.email), proof.now, SIGNUP_CODE_MAX_ATTEMPTS,
    );
  return {
    consume,
    guard: "EXISTS (SELECT 1 FROM signup_email_challenges WHERE challenge_id_hash = ? AND consumed_by = ?)",
    guardBinds: [idHash, nonce],
  };
}

/** adsbook.id brand values (DESIGN-SYSTEM §1), inline because mail clients drop <style>. */
const INK = "#0f172a";
const MUTED = "#475569";
const BLUE = "#2563eb";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SUBJECT = "Kode verifikasi pendaftaran adsbook.id";
const LEAD = "Masukkan kode ini di halaman pendaftaran adsbook.id untuk memastikan email ini milik Anda:";
const VALIDITY = "Kode berlaku 10 menit dan hanya bisa dipakai sekali.";
const SECURITY = "Jangan berikan kode ini kepada siapa pun, termasuk yang mengaku dari adsbook.id. Jika Anda tidak sedang mendaftar, abaikan email ini.";
const AUTOMATIC = "Email ini dikirim otomatis dan tidak menerima balasan.";

/**
 * The code mail, Indonesian, separate from the signup confirmation. No link,
 * no image, no tracking; the code is not in the subject (notification
 * previews). Plain text and HTML say the same.
 */
export function signupCodeMessage(to: string, code: string): SellerEmailMessage {
  const text = ["Kode verifikasi pendaftaran", "", LEAD, "", code, "", VALIDITY, "", SECURITY, AUTOMATIC].join("\n");
  const cell = (style: string, inner: string) => `<tr><td style="${style}">${inner}</td></tr>`;
  const body = `font-family:${FONT};font-size:16px;line-height:24px;color:${INK};padding:0 24px 16px 24px;`;
  const html =
    `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${SUBJECT}</title></head><body style="margin:0;padding:0;background:#ffffff;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;"><tr><td align="center" style="padding:0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;">` +
    `<tr><td height="4" style="height:4px;line-height:4px;font-size:4px;background:${BLUE};" bgcolor="${BLUE}">&nbsp;</td></tr>` +
    cell(`font-family:${FONT};font-size:28px;line-height:32px;font-weight:700;letter-spacing:-0.02em;color:${INK};padding:28px 24px 20px 24px;`, `adsbook<span style="color:${BLUE};">.</span>id`) +
    cell(`font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:${INK};padding:0 24px 12px 24px;`, "Kode verifikasi pendaftaran") +
    cell(body, LEAD) +
    cell(`font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;line-height:40px;font-weight:700;letter-spacing:0.2em;color:${INK};padding:4px 24px 20px 24px;`, code) +
    cell(body, VALIDITY) +
    cell(`font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};padding:16px 24px 32px 24px;border-top:1px solid #e2e8f0;`, `${SECURITY}<br>${AUTOMATIC}`) +
    `</table></td></tr></table></body></html>`;
  return { to, from: SELLER_EMAIL_FROM, subject: SUBJECT, text, html };
}

/** Resolves only when the transport's `send()` returned in time; any other outcome is a failure here. */
export async function sendSignupCode(transport: EmailTransport, message: SellerEmailMessage): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("signup code send timed out")), SIGNUP_CODE_SEND_TIMEOUT_MS);
  });
  try {
    await Promise.race([transport(message), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
