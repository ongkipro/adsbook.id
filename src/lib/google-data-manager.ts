/**
 * Google Ads offline conversions through the Data Manager API (tracking chapter 11 §3):
 * `POST https://datamanager.googleapis.com/v1/events:ingest`, OAuth scope
 * `https://www.googleapis.com/auth/datamanager`, no developer token.
 *
 * Shapes follow Google's reference and its "send offline conversions" guide
 * (developers.google.com/data-manager/api, read 2026-11-18):
 * - a destination is `operatingAccount { accountType: GOOGLE_ADS, accountId }` (the
 *   10-digit customer id, no dashes), `loginAccount` when access goes through a manager,
 *   and `productDestinationId` = the conversion action id (an UPLOAD_CLICKS action);
 * - an event carries `transactionId`, `eventTimestamp` (RFC 3339), `eventSource: WEB`,
 *   `currency`, `conversionValue`, `adIdentifiers`, and optionally `consent` and `userData`;
 * - `UserIdentifier` is a union: each element holds exactly one of `phoneNumber`,
 *   `emailAddress` or `address`, and an address needs all of `givenName`, `familyName`,
 *   `regionCode` and `postalCode`; `encoding` is required whenever user data is sent;
 * - `validateOnly: true` validates without ingesting; an invalid request fails whole (400).
 */
import { grantsAdUserDataByDefault } from "./google-consent-regions.ts";
import { sha256Hex } from "./meta-identity.ts";
import { toTikTokPhone } from "./tiktok-events.ts";

export const DATA_MANAGER_INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";
export const DATA_MANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager";

export type HashedUserIdentifier =
  | { phoneNumber: string }
  | { emailAddress: string }
  | { address: { givenName: string; familyName: string; regionCode: "ID"; postalCode: string } };

/** Lowercase, punctuation removed, single spaces, trimmed: Google's rule for names. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

/**
 * The hashed identifiers for one buyer, each its own union element. Phone is E.164 **with**
 * the `+` (the same form TikTok uses; Meta hashes digits only). Email only when the caller
 * passes a real buyer address (`matchableCustomerEmail`). The address only when the name
 * has a family part and a postal code exists, because Google requires all four fields.
 */
export async function buildGoogleUserIdentifiers(input: {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  postalCode?: string | null;
}): Promise<HashedUserIdentifier[]> {
  const identifiers: HashedUserIdentifier[] = [];
  const phone = toTikTokPhone(input.phone);
  if (phone) identifiers.push({ phoneNumber: await sha256Hex(phone) });
  const email = input.email?.trim().toLowerCase();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) identifiers.push({ emailAddress: await sha256Hex(email) });
  const words = normalizeName(input.name ?? "").split(" ").filter(Boolean);
  const postalCode = String(input.postalCode ?? "").replace(/\s+/g, "").trim();
  if (words.length >= 2 && /^[A-Za-z0-9-]{3,10}$/.test(postalCode)) {
    identifiers.push({
      address: {
        givenName: await sha256Hex(words[0]),
        familyName: await sha256Hex(words.slice(1).join(" ")),
        regionCode: "ID",
        postalCode,
      },
    });
  }
  return identifiers;
}

/**
 * User data rides along only with consent, and consent is assumed only where the storefront's
 * own Consent Mode grants it by default: a known country outside the EEA/UK/CH. Otherwise
 * the conversion carries its click id and value, and no personal data.
 */
export async function consentedUserIdentifiers(
  country: string | null | undefined,
  buyer: Parameters<typeof buildGoogleUserIdentifiers>[0],
): Promise<{ consentGranted: boolean; userIdentifiers: HashedUserIdentifier[] }> {
  if (!grantsAdUserDataByDefault(country)) return { consentGranted: false, userIdentifiers: [] };
  return { consentGranted: true, userIdentifiers: await buildGoogleUserIdentifiers(buyer) };
}

/** The mode-neutral record the outbox stores; translated to either API when sent. */
export type GoogleConversionRecord = {
  v: 2;
  orderNumber: string;
  /** ISO 8601 instant. */
  eventTime: string;
  value: number;
  currency: "IDR";
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  consentGranted: boolean;
  userIdentifiers?: HashedUserIdentifier[];
};

export type DataManagerDestination = {
  customerId: string;
  conversionActionId: string;
  loginCustomerId?: string;
};

/**
 * The `events:ingest` body for one conversion. One click identifier, as the Ads API path
 * sends (gclid, else gbraid, else wbraid). Consent and user data only when consent was
 * recorded; `encoding: HEX` whenever user data is present.
 */
export function buildDataManagerRequest(
  record: GoogleConversionRecord,
  destination: DataManagerDestination,
  options: { validateOnly?: boolean } = {},
) {
  const adIdentifiers = record.gclid
    ? { gclid: record.gclid }
    : record.gbraid
      ? { gbraid: record.gbraid }
      : record.wbraid
        ? { wbraid: record.wbraid }
        : undefined;
  const userIdentifiers = record.consentGranted ? (record.userIdentifiers ?? []).slice(0, 10) : [];
  const event = {
    transactionId: record.orderNumber,
    eventTimestamp: record.eventTime,
    eventSource: "WEB" as const,
    currency: record.currency,
    conversionValue: record.value,
    ...(adIdentifiers ? { adIdentifiers } : {}),
    ...(record.consentGranted
      ? { consent: { adUserData: "CONSENT_GRANTED" as const, adPersonalization: "CONSENT_GRANTED" as const } }
      : {}),
    ...(userIdentifiers.length ? { userData: { userIdentifiers } } : {}),
  };
  return {
    destinations: [
      {
        operatingAccount: { accountType: "GOOGLE_ADS" as const, accountId: destination.customerId },
        ...(destination.loginCustomerId
          ? { loginAccount: { accountType: "GOOGLE_ADS" as const, accountId: destination.loginCustomerId } }
          : {}),
        productDestinationId: destination.conversionActionId,
      },
    ],
    events: [event],
    ...(userIdentifiers.length ? { encoding: "HEX" as const } : {}),
    ...(options.validateOnly ? { validateOnly: true } : {}),
  };
}

export type DataManagerResult = {
  /** HTTP status; 0 when no answer arrived. */
  httpStatus: number;
  requestId?: string;
  warnings?: string[];
  /** Google's error status (e.g. INVALID_ARGUMENT, ALREADY_EXISTS) and message, never a credential. */
  errorStatus?: string;
  reason?: string;
};

const FETCH_TIMEOUT_MS = 10_000;

/** Never throws; the access token travels only in the Authorization header. */
export async function sendDataManagerRequest(
  body: ReturnType<typeof buildDataManagerRequest>,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DataManagerResult> {
  try {
    const response = await fetchImpl(DATA_MANAGER_INGEST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => null)) as {
      requestId?: unknown;
      fieldWarnings?: unknown;
      error?: { status?: unknown; message?: unknown };
    } | null;
    const warnings = Array.isArray(json?.fieldWarnings)
      ? json.fieldWarnings.map((warning) => JSON.stringify(warning).slice(0, 200)).slice(0, 5)
      : undefined;
    return {
      httpStatus: response.status,
      requestId: typeof json?.requestId === "string" ? json.requestId : undefined,
      ...(warnings?.length ? { warnings } : {}),
      errorStatus: typeof json?.error?.status === "string" ? json.error.status : undefined,
      reason: typeof json?.error?.message === "string" ? json.error.message.slice(0, 300) : undefined,
    };
  } catch (error) {
    return { httpStatus: 0, reason: error instanceof Error ? error.message.slice(0, 300) : "network error" };
  }
}

export type DataManagerDecision =
  | { status: "sent" | "failed" | "pending"; delayMs: number }
  | { status: "account"; delayMs: 0 };

/**
 * What one `events:ingest` answer means for its row.
 *
 * - 2xx: sent (field warnings are logged, not failures).
 * - No answer or 5xx: transient, doubling from 2 min to 1 h — checked before any 4xx rule,
 *   so a gateway fault is never terminal.
 * - 429: 15 minutes.
 * - 409 / ALREADY_EXISTS: Google already holds this transaction — sent.
 * - 401 / 403: the account's answer (revoked consent, missing scope, no access to the
 *   customer), not this row's: `account` — the drain leaves the row pending and stops the
 *   batch, as the Ads API path does, and the stalled queue raises its alert.
 * - Any other 4xx (400 invalid argument, 404): terminal.
 */
export function decideDataManagerRetry(result: DataManagerResult, attempts: number, maxAttempts: number): DataManagerDecision {
  const status = result.httpStatus;
  if (status >= 200 && status < 300) return { status: "sent", delayMs: 0 };
  const nextAttempt = attempts + 1;
  if (status === 0 || status >= 500) {
    return nextAttempt >= maxAttempts
      ? { status: "failed", delayMs: 0 }
      : { status: "pending", delayMs: Math.min(2 ** nextAttempt, 60) * 60_000 };
  }
  if (status === 429) return nextAttempt >= maxAttempts ? { status: "failed", delayMs: 0 } : { status: "pending", delayMs: 15 * 60_000 };
  if (status === 409 || result.errorStatus === "ALREADY_EXISTS") return { status: "sent", delayMs: 0 };
  if (status === 401 || status === 403) return { status: "account", delayMs: 0 };
  return { status: "failed", delayMs: 0 };
}

export function describeDataManagerResult(result: DataManagerResult): string {
  if (result.httpStatus === 0) return `network: ${result.reason ?? "error"}`;
  return `Data Manager HTTP ${result.httpStatus}${result.errorStatus ? ` ${result.errorStatus}` : ""}${result.reason ? `: ${result.reason}` : ""}`.slice(0, 300);
}
