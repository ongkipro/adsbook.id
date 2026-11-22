/**
 * Reads the signup verification code from Wrangler's LOCAL email capture, for the local seed and the browser suite.
 *
 * Miniflare's Local Explorer lists what a Worker sent through its `send_email` binding:
 *
 *   GET <loopback>/cdn-cgi/local/explorer/api/local/email/sending                  the list, newest first
 *   GET <loopback>/cdn-cgi/local/explorer/api/local/email/sending?email_id=<id>    one message with its text
 *
 * This is a fixture reader and nothing else. It lives in `scripts/`, imports nothing from `src/`, and no
 * production code calls it: the product has no readback of its own, so the code only ever leaves the Worker
 * in a mail, and the same server gate (a real challenge, a keyed digest, an atomic claim) decides every signup.
 * It cannot be pointed at a deployed Worker: the address must be loopback and the recipient synthetic.
 *
 * What the Local Explorer is, so nobody extends this carelessly (measured on wrangler 4.160.0 / miniflare 5.20261110):
 *   - on by default (`X_LOCAL_EXPLORER`), and it also lists every other worker and store of the same dev instance;
 *   - it answers only a Host and an Origin that are localhost, 127.0.0.1 or [::1] (a foreign one is a 403, so a web
 *     page cannot read it), but it does not look at the peer address: a dev server bound to a LAN or tailnet address
 *     serves it to anyone who can reach that address and sends a loopback Host header;
 *   - it also exposes email send and resend endpoints and browsers for KV, D1, R2 and Durable Objects.
 * So: start the dev server on loopback only, and never pass `--ip` with a non-loopback address while this is in use.
 *
 * Which mail is "the" mail: the caller takes `sentVerificationIds()` BEFORE the action that causes the mail and passes
 * it as `ignore`; the code is read from the newest mail to exactly that recipient that is not in the set. No clock is
 * compared, so a mail from an earlier attempt for the same address can never be read by mistake.
 */

/** The only hosts this helper talks to. Compared on the parsed hostname, never on the raw string. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Reserved or local-only names (RFC 2606, RFC 6761): a mail to them can never reach a person. */
const SYNTHETIC_TLDS = ["test", "example", "invalid", "localhost"];
const SUBJECT = "Kode verifikasi pendaftaran adsbook.id";
/** The owner password reset mail (src/platform/owner-reset.ts); read only when a caller asks for it by name. */
export const RESET_SUBJECT = "Kode reset password adsbook.id";
const LIST_PATH = "/cdn-cgi/local/explorer/api/local/email/sending";
const CODE_LINE = /^\d{8}$/gm;
const DEFAULT_TIMEOUT_MS = 20_000;

export type MailboxOptions = {
  /** The dev server's loopback origin, e.g. `http://127.0.0.1:8807`. */
  explorer: string;
  /** Message ids captured before the action that causes the mail (`sentVerificationIds`). */
  ignore: ReadonlySet<string>;
  timeoutMs?: number;
  pollMs?: number;
  /** Which code mail to read; the signup verification mail unless named. */
  subject?: string;
};

type SentItem = { messageId: string; to: string[]; subject: string; sentAt: string };

/** Throws unless the URL is plain http on a loopback host. Returns the origin to use. */
export function loopbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("[mailbox] the explorer address is not a URL");
  }
  if (url.protocol !== "http:") throw new Error("[mailbox] refusing a non-http explorer address: only plain http on loopback is allowed");
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("[mailbox] refusing a non-loopback host: the local email capture must not be reached over a network");
  }
  return url.origin;
}

/** Throws unless the address can only exist in a test: its domain is, or ends in, a reserved or local-only name. */
export function assertSyntheticRecipient(address: string): string {
  const normalised = address.trim().toLowerCase();
  const at = normalised.lastIndexOf("@");
  const domain = at < 0 ? "" : normalised.slice(at + 1);
  const tld = domain.split(".").at(-1) ?? "";
  // A local part is required: "@x.test" is not an address.
  if (at < 1 || !domain || !SYNTHETIC_TLDS.includes(tld)) {
    throw new Error("[mailbox] refusing a recipient that is not synthetic (.test, .example, .invalid or .localhost)");
  }
  return normalised;
}

const bounded = (url: string) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });

/**
 * The first page of the capture, newest first. // lazy: first page only (100): the mail awaited is among the newest;
 * upgrade path: follow `result_info.cursor` while `result_info.has_more`.
 */
async function listSent(origin: string): Promise<SentItem[]> {
  const response = await bounded(`${origin}${LIST_PATH}?${new URLSearchParams({ per_page: "100" })}`);
  if (response.status !== 200) {
    throw new Error(`[mailbox] the local email list answered HTTP ${response.status} (is the dev server running on this port, and X_LOCAL_EXPLORER not disabled?)`);
  }
  const body = (await response.json()) as { result?: SentItem[] };
  return Array.isArray(body.result) ? body.result : [];
}

/** The verification mails to exactly `recipient`, newest first. Anything else in the capture is ignored. */
async function verificationMails(origin: string, recipient: string, subject = SUBJECT): Promise<SentItem[]> {
  return (await listSent(origin)).filter(
    (item) => item.subject === subject && item.to.length === 1 && item.to[0].toLowerCase() === recipient,
  );
}

/** The ids of the verification mails to `recipient` captured right now. Take it before the action that sends a new one. */
export async function sentVerificationIds(explorer: string, recipient: string, subject = SUBJECT): Promise<Set<string>> {
  const wanted = assertSyntheticRecipient(recipient);
  return new Set((await verificationMails(loopbackOrigin(explorer), wanted, subject)).map((item) => item.messageId));
}

/** The eight digits on their own line of a mail's plain text. Exactly one such line, or it is not a code mail. */
export function codeFromText(text: string): string {
  const found = text.match(CODE_LINE) ?? [];
  if (found.length !== 1) throw new Error(`[mailbox] expected one 8-digit line in the verification mail, found ${found.length}`);
  return found[0];
}

/**
 * Waits for a new verification mail to `recipient` and returns its code. Never prints the code.
 * `ignore` is what `sentVerificationIds` returned before the request that causes the mail.
 *
 * The explorer address and the recipient are checked before the first request, so a refusal comes back at once. Inside
 * the loop only the network is retried (the server not up yet, a mail not captured yet). A mail that IS captured but has
 * no code line is a defect in the mail and will not fix itself: that is reported at once, not after the deadline.
 */
export async function readVerificationCode(recipient: string, options: MailboxOptions): Promise<string> {
  const wanted = assertSyntheticRecipient(recipient);
  const origin = loopbackOrigin(options.explorer);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const pollMs = options.pollMs ?? 250;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    let body: string | null = null;
    try {
      const fresh = (await verificationMails(origin, wanted, options.subject)).find((item) => !options.ignore.has(item.messageId));
      if (fresh) {
        const response = await bounded(`${origin}${LIST_PATH}?${new URLSearchParams({ email_id: fresh.messageId })}`);
        if (response.status !== 200) throw new Error(`[mailbox] the local email detail answered HTTP ${response.status}`);
        body = ((await response.json()) as { result?: { text?: string } }).result?.text ?? "";
      }
    } catch (error) {
      lastError = error;
    }
    if (body !== null) return codeFromText(body);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const why = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
  throw new Error(`[mailbox] no new verification mail for the recipient within ${timeoutMs} ms${why}`);
}
