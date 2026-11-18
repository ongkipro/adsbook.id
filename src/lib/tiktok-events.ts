/**
 * TikTok Events API (v1.3) for one store: identity normalisation, the event
 * payload, the HTTP call, and how its answer is classified for retry.
 * Tracking chapter 11 §2.2–§2.4 (docs repository) is the contract.
 *
 * TikTok differs from Meta in one place that silently costs matching: the
 * phone is hashed in E.164 form **with** the leading `+` (`+6281234567890`),
 * while Meta's `ph` hashes the digits alone (`6281234567890`). Both are built
 * from the same `toE164Digits`, so the two legs never disagree on the number,
 * only on the one character each platform asks for.
 *
 * `ttclid`, `ttp`, `ip` and `user_agent` are sent raw; phone, email and
 * external_id are SHA-256 lower-hex. Hashing happens before the event is
 * stored in the outbox, so the outbox never holds a buyer's phone in clear.
 */
import { sha256Hex, toE164Digits } from "./meta-identity.ts";
import { isValidTikTokTtp } from "./click-ids.ts";

export const TIKTOK_EVENTS_ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/** The server leg's events. PageView stays browser-only, as in the contract's funnel table. */
export const TIKTOK_SERVER_EVENTS = ["ViewContent", "AddToCart", "InitiateCheckout", "CompletePayment"] as const;
export type TikTokServerEvent = (typeof TIKTOK_SERVER_EVENTS)[number];

export function isTikTokServerEvent(value: unknown): value is TikTokServerEvent {
  return typeof value === "string" && (TIKTOK_SERVER_EVENTS as readonly string[]).includes(value);
}

/** `ttclid` as the click-id cookie validates it (`[A-Za-z0-9._-]{1,256}`). */
const TTCLID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const EXTERNAL_ID_PATTERN = /^[a-f0-9]{32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Clients that are not a buyer's browser; TikTok scores a server UA as noise. */
const SERVER_USER_AGENT = /^(node|undici|curl|wget|python|go-http-client|axios|okhttp|java)\b/i;

/** `+62…` for TikTok (and Google), from whatever the buyer typed. */
export function toTikTokPhone(value?: string | null): string | undefined {
  const digits = toE164Digits(value ?? undefined);
  return digits ? `+${digits}` : undefined;
}

export type TikTokIdentityInput = {
  phone?: string | null;
  /** Only a real buyer address: pass it through `matchableCustomerEmail` first. */
  email?: string | null;
  /** The 32-hex first-party visitor id (`META_EXTERNAL_ID_COOKIE`). */
  externalId?: string | null;
  ttclid?: string | null;
  ttp?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  locale?: string | null;
};

export type TikTokUser = {
  ttclid?: string;
  ttp?: string;
  phone?: string;
  email?: string;
  external_id?: string;
  ip?: string;
  user_agent?: string;
  locale?: string;
};

export function isBrowserUserAgent(value?: string | null): value is string {
  const cleaned = value?.trim() ?? "";
  return Boolean(cleaned) && cleaned.length <= 512 && !SERVER_USER_AGENT.test(cleaned);
}

/** Every key absent rather than empty: TikTok scores an empty key as a bad one. */
export async function buildTikTokUserData(input: TikTokIdentityInput): Promise<TikTokUser> {
  const user: TikTokUser = {};
  const ttclid = input.ttclid?.trim();
  if (ttclid && TTCLID_PATTERN.test(ttclid)) user.ttclid = ttclid;
  const ttp = input.ttp?.trim();
  if (isValidTikTokTtp(ttp)) user.ttp = ttp;
  const phone = toTikTokPhone(input.phone);
  if (phone) user.phone = await sha256Hex(phone);
  const email = input.email?.trim().toLowerCase();
  if (email && EMAIL_PATTERN.test(email)) user.email = await sha256Hex(email);
  const externalId = input.externalId?.trim().toLowerCase();
  if (externalId && EXTERNAL_ID_PATTERN.test(externalId)) user.external_id = await sha256Hex(externalId);
  const ip = input.ip?.trim();
  if (ip && ip.length <= 64 && ip.toLowerCase() !== "unknown") user.ip = ip;
  if (isBrowserUserAgent(input.userAgent)) user.user_agent = input.userAgent.trim();
  const locale = input.locale?.trim();
  if (locale && /^[a-z]{2}(?:[-_][A-Za-z]{2})?$/.test(locale)) user.locale = locale;
  return user;
}

export type TikTokContent = {
  content_id: string;
  content_name?: string;
  price?: number;
  quantity: number;
};

export type TikTokProperties = {
  currency: "IDR";
  value: number;
  content_type: "product";
  order_id?: string;
  contents?: TikTokContent[];
};

/** One element of the request's `data` array, as stored in the outbox. */
export type TikTokEventData = {
  event: TikTokServerEvent;
  /** Unix seconds. */
  event_time: number;
  event_id: string;
  user: TikTokUser;
  properties: TikTokProperties;
  page: { url: string };
};

export function tikTokProperties(input: {
  value: number;
  orderNumber?: string;
  contents?: TikTokContent[];
}): TikTokProperties {
  const value = Number.isFinite(Number(input.value)) ? Math.max(0, Number(input.value)) : 0;
  const contents = (input.contents ?? []).filter((item) => item.content_id);
  return {
    currency: "IDR",
    value,
    content_type: "product",
    ...(input.orderNumber ? { order_id: input.orderNumber } : {}),
    ...(contents.length ? { contents } : {}),
  };
}

export function buildTikTokRequestBody(pixelId: string, data: TikTokEventData[], testEventCode?: string) {
  return {
    event_source: "web",
    event_source_id: pixelId,
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
    data,
  };
}

export type TikTokSendResult = {
  httpStatus: number;
  /** TikTok's own `code`; 0 is success. Absent when the answer was not JSON. */
  code?: number;
  message?: string;
};

/** Never throws: a network failure is a result like any other. */
export async function sendTikTokEvents(
  pixelId: string,
  accessToken: string,
  data: TikTokEventData[],
  testEventCode?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TikTokSendResult> {
  try {
    const response = await fetchImpl(TIKTOK_EVENTS_ENDPOINT, {
      method: "POST",
      headers: { "Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(buildTikTokRequestBody(pixelId, data, testEventCode)),
    });
    const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
    return {
      httpStatus: response.status,
      code: typeof body?.code === "number" ? body.code : undefined,
      message: typeof body?.message === "string" ? body.message.slice(0, 300) : undefined,
    };
  } catch (error) {
    return { httpStatus: 0, message: error instanceof Error ? error.message.slice(0, 300) : "network error" };
  }
}

export type TikTokRetryDecision = { status: "sent" | "pending" | "failed"; delayMs: number };

/** TikTok's "requests made too frequently". */
export const TIKTOK_RATE_LIMIT_CODE = 40100;

/**
 * Pure, so the ladder is testable without a network.
 *
 * - HTTP 2xx with `code` 0: sent.
 * - HTTP 5xx or no answer (network): doubling backoff, whatever code the
 *   body carries — a gateway fault is never a terminal client error.
 * - Rate limit (HTTP 429 or code 40100): a flat 15 minutes.
 * - Any other 4xxxx code (permission, parameter, token): terminal at once —
 *   the same request can never succeed, and retrying a dead token only burns
 *   attempts. `/admin/ads/tiktok` requeues them after a proven test event.
 * - Code 5xxxx, HTTP 5xx, an unreadable answer or a network error: doubling
 *   from two minutes, capped at an hour, until `maxAttempts`.
 *
 * lazy: the code meanings come from TikTok's API-for-Business convention
 * (40100 rate limit, other 40xxx client errors, 50000 server error); the
 * official table is behind a script-rendered portal. Upgrade path: pin each
 * code here once a live Events API answer has been observed for it.
 */
export function decideTikTokRetry(result: TikTokSendResult, attempts: number, maxAttempts: number): TikTokRetryDecision {
  const ok = result.httpStatus >= 200 && result.httpStatus < 300;
  if (ok && result.code === 0) return { status: "sent", delayMs: 0 };
  const nextAttempt = attempts + 1;
  // A gateway or network fault first: a 5xx (or no answer) is transient
  // whatever code a proxy put in its body, so a 503 carrying 40002 retries.
  if (result.httpStatus === 0 || result.httpStatus >= 500) {
    return nextAttempt >= maxAttempts
      ? { status: "failed", delayMs: 0 }
      : { status: "pending", delayMs: Math.min(2 ** nextAttempt, 60) * 60_000 };
  }
  if (result.httpStatus === 429 || result.code === TIKTOK_RATE_LIMIT_CODE) {
    return nextAttempt >= maxAttempts ? { status: "failed", delayMs: 0 } : { status: "pending", delayMs: 15 * 60_000 };
  }
  const clientError =
    (typeof result.code === "number" && result.code >= 40000 && result.code < 50000) ||
    (result.httpStatus >= 400 && result.httpStatus < 500);
  if (clientError || nextAttempt >= maxAttempts) return { status: "failed", delayMs: 0 };
  return { status: "pending", delayMs: Math.min(2 ** nextAttempt, 60) * 60_000 };
}

/** One line for `last_error`, never the token. */
export function describeTikTokResult(result: TikTokSendResult): string {
  if (result.httpStatus === 0) return `network: ${result.message ?? "error"}`;
  const code = result.code === undefined ? "no code" : `code ${result.code}`;
  return `HTTP ${result.httpStatus}, ${code}${result.message ? `: ${result.message}` : ""}`.slice(0, 300);
}

/** The browser events `/api/tiktok-event` accepts. CompletePayment never: it leaves from the order itself. */
export const TIKTOK_FUNNEL_EVENTS = ["ViewContent", "AddToCart", "InitiateCheckout"] as const;
export type TikTokFunnelEvent = (typeof TIKTOK_FUNNEL_EVENTS)[number];

const FUNNEL_EVENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_VALUE = 10_000_000_000;

export type TikTokFunnelPayload = {
  event: TikTokFunnelEvent;
  eventId: string;
  url: string;
  value: number;
  contents: TikTokContent[];
  phone?: string;
};

/**
 * The public endpoint's whole trust boundary: an allowlisted event name, a
 * bounded id, a same-origin page URL (anything else becomes the request's own
 * URL), at most ten well-formed contents, a bounded value. The phone, when
 * present, is only ever hashed.
 */
export function validateTikTokFunnelPayload(
  raw: unknown,
  requestUrl: string,
): { ok: true; value: TikTokFunnelPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Payload tidak valid." };
  const body = raw as Record<string, unknown>;
  const event = body.event;
  if (typeof event !== "string" || !(TIKTOK_FUNNEL_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, error: "Event tidak didukung." };
  }
  const eventId = typeof body.event_id === "string" ? body.event_id.trim() : "";
  if (!FUNNEL_EVENT_ID_PATTERN.test(eventId)) return { ok: false, error: "event_id tidak valid." };

  const origin = new URL(requestUrl).origin;
  let url = new URL("/", origin).toString();
  if (typeof body.url === "string") {
    try {
      const candidate = new URL(body.url);
      if (candidate.origin === origin) url = candidate.toString().slice(0, 2048);
    } catch {
      // A malformed URL falls back to the store's own origin.
    }
  }

  const properties = (body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
    ? body.properties
    : {}) as Record<string, unknown>;
  const rawValue = Number(properties.value);
  const value = Number.isFinite(rawValue) && rawValue >= 0 && rawValue <= MAX_VALUE ? rawValue : 0;
  const contents: TikTokContent[] = [];
  if (Array.isArray(properties.contents)) {
    for (const item of properties.contents.slice(0, 10)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const contentId = typeof entry.content_id === "string" ? entry.content_id.trim() : "";
      if (!CONTENT_ID_PATTERN.test(contentId)) continue;
      const price = Number(entry.price);
      const quantity = Math.trunc(Number(entry.quantity));
      contents.push({
        content_id: contentId,
        content_name: typeof entry.content_name === "string" ? entry.content_name.trim().slice(0, 200) || undefined : undefined,
        price: Number.isFinite(price) && price >= 0 && price <= MAX_VALUE ? price : undefined,
        quantity: quantity >= 1 && quantity <= 999 ? quantity : 1,
      });
    }
  }
  const phone = typeof body.phone === "string" && body.phone.length <= 32 ? body.phone : undefined;
  return { ok: true, value: { event: event as TikTokFunnelEvent, eventId, url, value, contents, phone } };
}

/**
 * Review finding 1: who may post a funnel event. `/api/tiktok-event` is public,
 * and a CORS-simple POST (`text/plain`) from any other site would otherwise be
 * accepted from every visitor's own IP — fabricated events in the seller's
 * pixel and their Events API quota spent, with no rate limit able to tell.
 *
 * - The body must be declared `application/json`: a cross-origin page cannot
 *   send that without a preflight, which this route never answers.
 * - A browser's `Origin` must be the store's own, or one the seller allowed for
 *   embedding (`embed_allowed_origins`). The pixel only runs on store pages,
 *   the embed iframe included, so the store's own origin is the normal case.
 * - With no `Origin`, a `Sec-Fetch-Site` other than `same-origin`/`none` is refused.
 * - A request with neither header is not a browser: it passes on to the rate limit.
 */
export function tiktokEventRequestRefusal(
  request: Request,
  allowedOrigins: readonly string[] = [],
): { status: 403 | 415; error: string } | null {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return { status: 415, error: "Content-Type harus application/json." };
  }
  const own = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === own || allowedOrigins.includes(origin) ? null : { status: 403, error: "Origin tidak diizinkan." };
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return { status: 403, error: "Origin tidak diizinkan." };
  return null;
}
