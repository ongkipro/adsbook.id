import {
  isValidMetaBrowserId,
  isValidMetaExternalId,
  isValidTikTokTtp,
  readMetaBrowserIds,
  readTikTokBrowserIds,
} from "./click-ids.ts";
import { getClientIp } from "./rate-limit.ts";

/** Original browser/request identity retained for a delayed paid Purchase. */
export type MetaOrderContext = {
  externalId?: string;
  fbp?: string;
  fbc?: string;
  clientIp?: string;
  userAgent?: string;
  /** TikTok's first-party `_ttp` cookie, for a CompletePayment sent after the buyer left. */
  ttp?: string;
  /**
   * The buyer's country at checkout (`CF-IPCountry`, ISO 3166-1 alpha-2). The Google server
   * conversion sends user data only when this is known and outside the EEA/UK/CH
   * (`google-consent-regions.ts`), the same rule the storefront's Consent Mode applies.
   */
  country?: string;
};

function cleanCountry(value: unknown): string | undefined {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : undefined;
}

const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

function cleanClientIp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  if (!cleaned || cleaned.toLowerCase() === "unknown" || cleaned.length > MAX_IP_LENGTH) {
    return undefined;
  }
  return cleaned;
}

function cleanUserAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= MAX_USER_AGENT_LENGTH ? cleaned : undefined;
}

/**
 * `buyerDirect` (default true): the request came from the buyer's own browser, so
 * `CF-IPCountry` is the buyer's country. A headless checkout (`/api/v1/checkout`) is
 * usually called by the merchant's server, whose country says nothing about the buyer
 * or their consent: it passes `false`, the country stays unknown, and the Google server
 * conversion then carries no user data (review 2026-11-18).
 */
export function captureMetaOrderContext(request: Request, options: { buyerDirect?: boolean } = {}): MetaOrderContext {
  const buyerDirect = options.buyerDirect !== false;
  const browserIds = readMetaBrowserIds(request);
  return {
    externalId: browserIds.externalId,
    fbp: browserIds.fbp,
    fbc: browserIds.fbc,
    clientIp: cleanClientIp(getClientIp(request.headers)),
    userAgent: cleanUserAgent(request.headers.get("user-agent")),
    ...withTtp(readTikTokBrowserIds(request).ttp),
    ...withCountry(buyerDirect ? cleanCountry(request.headers.get("cf-ipcountry")) : undefined),
  };
}

/** Present only when there is one, so a context without TikTok keeps its exact shape. */
function withTtp(ttp: string | undefined): { ttp?: string } {
  return ttp ? { ttp } : {};
}

function withCountry(country: string | undefined): { country?: string } {
  return country ? { country } : {};
}

export function serializeMetaOrderContext(
  context: MetaOrderContext,
): string | undefined {
  const cleaned = normalizeMetaOrderContext(context);
  return Object.values(cleaned).some(Boolean) ? JSON.stringify(cleaned) : undefined;
}

export function parseMetaOrderContext(raw: unknown): MetaOrderContext {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return normalizeMetaOrderContext(JSON.parse(raw) as MetaOrderContext);
  } catch {
    return {};
  }
}

function normalizeMetaOrderContext(context: MetaOrderContext): MetaOrderContext {
  const normalized: MetaOrderContext = {};
  if (isValidMetaExternalId(context?.externalId)) {
    normalized.externalId = context.externalId;
  }
  if (isValidMetaBrowserId(context?.fbp)) normalized.fbp = context.fbp;
  if (isValidMetaBrowserId(context?.fbc)) normalized.fbc = context.fbc;
  const clientIp = cleanClientIp(context?.clientIp);
  if (clientIp) normalized.clientIp = clientIp;
  const userAgent = cleanUserAgent(context?.userAgent);
  if (userAgent) normalized.userAgent = userAgent;
  if (isValidTikTokTtp(context?.ttp)) normalized.ttp = context.ttp;
  const country = cleanCountry(context?.country);
  if (country) normalized.country = country;
  return normalized;
}
