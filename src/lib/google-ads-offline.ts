const GOOGLE_ADS_API_VERSION = "v25";
const PAID_STATUSES = ["paid", "settled", "success"] as const;
const MAX_RECONCILE_BATCH = 50;
const MAX_DRAIN_BATCH = 10;

/** Longest delay `decideGoogleRetry` can schedule. A pending row overdue by
 *  more than this is not waiting its turn — nothing is draining it. */
export const GOOGLE_ADS_MAX_BACKOFF_MS = 60 * 60_000;

export type GoogleAdsOutboxDepth = {
  pending: number;
  failed: number;
  /** Failed inside the alert window; see `CapiOutboxDepth.recentFailed`. */
  recentFailed?: number;
  overdue: number;
  oldestCreatedAt: string | null;
};

export type GoogleAdsOfflineConfig = {
  customerId: string;
  conversionActionId: string;
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string;
  startAt: string;
};

export type GoogleClickConversion = {
  conversionAction: string;
  conversionDateTime: string;
  conversionValue: number;
  currencyCode: "IDR";
  orderId: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
};

type EligibleOrder = {
  id: number;
  order_number: string;
  payment_method: string;
  payment_status: string;
  shipping_status: string;
  created_at: string;
  ad_click_ids: string | null;
  product_value: number;
};

type OutboxRow = {
  id: number;
  payload: string;
  attempts: number;
  max_attempts: number;
};

export type GoogleRetryDecision = {
  status: "sent" | "pending" | "failed";
  delayMs: number;
};

function digits(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

/** The tenant's saved offline-upload settings: a `stores` row (migration 0080). */
export type GoogleAdsOfflineRow = {
  google_ads_customer_id?: string | null;
  google_ads_offline_conversion_action_id?: string | null;
  google_ads_login_customer_id?: string | null;
  google_ads_offline_start_at?: string | null;
  google_ads_developer_token?: string | null;
  google_ads_client_id?: string | null;
  google_ads_client_secret?: string | null;
  google_ads_refresh_token?: string | null;
};

const OFFLINE_COLUMNS = [
  "google_ads_customer_id",
  "google_ads_offline_conversion_action_id",
  "google_ads_login_customer_id",
  "google_ads_offline_start_at",
  "google_ads_developer_token",
  "google_ads_client_id",
  "google_ads_client_secret",
  "google_ads_refresh_token",
] as const;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * The upload config, all or nothing, from what the tenant saved (T-45). There
 * is no Worker env fallback: one platform credential would upload every
 * tenant's conversions into one Google Ads account.
 */
export function readGoogleAdsOfflineConfig(
  row: GoogleAdsOfflineRow | null | undefined,
): GoogleAdsOfflineConfig | null {
  if (!row) return null;
  const text = (value: string | null | undefined) => String(value || "").trim();
  const customerId = digits(row.google_ads_customer_id);
  const conversionActionId = digits(row.google_ads_offline_conversion_action_id);
  const loginCustomerId = digits(row.google_ads_login_customer_id) || undefined;
  const startAt = text(row.google_ads_offline_start_at);
  const required = {
    developerToken: text(row.google_ads_developer_token),
    clientId: text(row.google_ads_client_id),
    clientSecret: text(row.google_ads_client_secret),
    refreshToken: text(row.google_ads_refresh_token),
  };
  if (
    !/^\d{5,20}$/.test(customerId) ||
    !/^\d{1,20}$/.test(conversionActionId) ||
    !ISO_INSTANT.test(startAt) ||
    Object.values(required).some((value) => !value)
  ) {
    return null;
  }
  return {
    customerId,
    conversionActionId,
    loginCustomerId,
    startAt,
    ...required,
  };
}

export async function loadGoogleAdsOfflineRow(database: D1Database): Promise<GoogleAdsOfflineRow | null> {
  return database
    .prepare(`SELECT ${OFFLINE_COLUMNS.join(", ")} FROM stores ORDER BY id LIMIT 1`)
    .first<GoogleAdsOfflineRow>();
}

export async function loadGoogleAdsOfflineConfig(database: D1Database): Promise<GoogleAdsOfflineConfig | null> {
  return readGoogleAdsOfflineConfig(await loadGoogleAdsOfflineRow(database));
}

/**
 * The columns an owner's save writes, or an error. Ids are submitted as text
 * (dashes allowed); a secret left empty keeps the stored one; `clear` removes
 * the whole set. `start_at` is stamped the first time the upload becomes
 * complete and kept after, so a later edit never backfills older orders.
 */
export function planGoogleAdsOfflineSave(
  input: {
    clear?: unknown;
    customerId?: unknown;
    conversionActionId?: unknown;
    loginCustomerId?: unknown;
    developerToken?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    refreshToken?: unknown;
  },
  current: GoogleAdsOfflineRow | null,
  now: Date,
): { ok: true; row: Required<{ [K in keyof GoogleAdsOfflineRow]: string | null }>; configured: boolean } | { ok: false; error: string } {
  if (input.clear === true) {
    const row = Object.fromEntries(OFFLINE_COLUMNS.map((column) => [column, null])) as Required<{
      [K in keyof GoogleAdsOfflineRow]: string | null;
    }>;
    return { ok: true, row, configured: false };
  }
  const submitted = [
    input.customerId, input.conversionActionId, input.loginCustomerId,
    input.developerToken, input.clientId, input.clientSecret, input.refreshToken,
  ];
  if (submitted.some((value) => value !== undefined && value !== null && typeof value !== "string")) {
    return { ok: false, error: "Pengaturan upload offline harus dikirim sebagai teks." };
  }
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  // Secrets: empty or left out keeps the stored value (they are never shown).
  const keep = (value: string, stored: string | null | undefined) => value || String(stored || "").trim();
  // Ids are shown, so an empty string clears one; a field left out keeps it.
  const id = (value: unknown, stored: string | null | undefined) =>
    value === undefined ? digits(stored) : digits(text(value, 32));
  const customerId = id(input.customerId, current?.google_ads_customer_id);
  const conversionActionId = id(input.conversionActionId, current?.google_ads_offline_conversion_action_id);
  const loginCustomerId = id(input.loginCustomerId, current?.google_ads_login_customer_id);
  if (customerId && !/^\d{5,20}$/.test(customerId)) return { ok: false, error: "Customer ID Google Ads tidak valid." };
  if (conversionActionId && !/^\d{1,20}$/.test(conversionActionId)) return { ok: false, error: "Conversion action ID harus berupa angka." };
  if (loginCustomerId && !/^\d{5,20}$/.test(loginCustomerId)) return { ok: false, error: "Login customer ID tidak valid." };
  const row = {
    google_ads_customer_id: customerId || null,
    google_ads_offline_conversion_action_id: conversionActionId || null,
    google_ads_login_customer_id: loginCustomerId || null,
    google_ads_offline_start_at: current?.google_ads_offline_start_at?.trim() || null,
    google_ads_developer_token: keep(text(input.developerToken, 200), current?.google_ads_developer_token) || null,
    google_ads_client_id: keep(text(input.clientId, 300), current?.google_ads_client_id) || null,
    google_ads_client_secret: keep(text(input.clientSecret, 300), current?.google_ads_client_secret) || null,
    google_ads_refresh_token: keep(text(input.refreshToken, 1000), current?.google_ads_refresh_token) || null,
  };
  if (!row.google_ads_offline_start_at) row.google_ads_offline_start_at = now.toISOString();
  const configured = readGoogleAdsOfflineConfig(row) !== null;
  if (!configured) row.google_ads_offline_start_at = current?.google_ads_offline_start_at?.trim() || null;
  return { ok: true, row, configured };
}

function readClickIds(raw: string | null): {
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
} {
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    const valid = (key: "gclid" | "gbraid" | "wbraid") => {
      const value = parsed[key];
      return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value)
        ? value
        : undefined;
    };
    return { gclid: valid("gclid"), gbraid: valid("gbraid"), wbraid: valid("wbraid") };
  } catch {
    return {};
  }
}

function googleDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

export function buildGoogleClickConversion(
  order: EligibleOrder,
  config: Pick<GoogleAdsOfflineConfig, "customerId" | "conversionActionId">,
  observedAt: Date,
): { conversion: GoogleClickConversion; qualification: "online_paid" | "cod_delivered" } | null {
  const qualification = order.payment_method === "cod"
    ? order.shipping_status === "delivered" ? "cod_delivered" : null
    : PAID_STATUSES.includes(order.payment_status as (typeof PAID_STATUSES)[number])
      ? "online_paid"
      : null;
  if (!qualification || !order.order_number || !(order.product_value > 0)) return null;

  const clickIds = readClickIds(order.ad_click_ids);
  const clickIdentity = clickIds.gclid
    ? { gclid: clickIds.gclid }
    : clickIds.gbraid
      ? { gbraid: clickIds.gbraid }
      : clickIds.wbraid
        ? { wbraid: clickIds.wbraid }
        : null;
  if (!clickIdentity) return null;

  return {
    qualification,
    conversion: {
      conversionAction: `customers/${config.customerId}/conversionActions/${config.conversionActionId}`,
      conversionDateTime: googleDateTime(observedAt),
      conversionValue: order.product_value,
      currencyCode: "IDR",
      orderId: order.order_number,
      ...clickIdentity,
    },
  };
}

export function decideGoogleRetry(
  success: boolean,
  statusCode: number | undefined,
  attempts: number,
  maxAttempts: number,
): GoogleRetryDecision {
  if (success) return { status: "sent", delayMs: 0 };
  const nextAttempt = attempts + 1;
  if (
    nextAttempt >= maxAttempts ||
    (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429)
  ) {
    return { status: "failed", delayMs: 0 };
  }
  const delayMs = statusCode === 429
    ? 15 * 60_000
    : Math.min(2 ** nextAttempt, 60) * 60_000;
  return { status: "pending", delayMs };
}

/**
 * What a `partialFailureError` (HTTP 200) means for the one conversion sent.
 *
 * It used to read as transient, so a permanent refusal was retried until the
 * budget ran out, and a conversion Google already held — the response lost on
 * the way back, then re-sent — ended `failed` although it counted. Codes are
 * `ConversionUploadError` values from the Ads API (v25 proto):
 * already-recorded means sent; the 6-hour "too recent" pair is worth one more
 * try later; anything else will fail the same way every time.
 */
const ALREADY_RECORDED = new Set(["CLICK_CONVERSION_ALREADY_EXISTS", "ORDER_ID_ALREADY_IN_USE"]);
const RETRY_AFTER_SIX_HOURS = new Set(["TOO_RECENT_EVENT", "TOO_RECENT_CONVERSION_ACTION"]);

export function classifyGooglePartialFailure(codes: readonly string[]): "sent" | "retry-later" | "terminal" {
  if (codes.length > 0 && codes.every((code) => ALREADY_RECORDED.has(code))) return "sent";
  if (codes.length > 0 && codes.every((code) => RETRY_AFTER_SIX_HOURS.has(code))) return "retry-later";
  return "terminal";
}

/** Every `conversionUploadError` code anywhere in a partial-failure payload. */
export function readConversionUploadErrorCodes(partialFailure: unknown): string[] {
  const codes: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "conversionUploadError" && typeof child === "string") codes.push(child);
      else visit(child);
    }
  };
  visit(partialFailure);
  return codes;
}

/** Bounded like the Meta leg (audit M-5, L-11): the cron must not hang on Google. */
const GOOGLE_FETCH_TIMEOUT_MS = 10_000;

async function accessToken(config: GoogleAdsOfflineConfig): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null) as { access_token?: unknown; error_description?: unknown } | null;
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new Error(typeof body?.error_description === "string" ? body.error_description : `Google OAuth HTTP ${response.status}`);
  }
  return body.access_token;
}

export async function uploadGoogleClickConversion(
  conversion: GoogleClickConversion,
  config: GoogleAdsOfflineConfig,
  providedAccessToken?: string,
): Promise<{ success: boolean; statusCode?: number; reason?: string; partialFailureCodes?: string[] }> {
  try {
    const token = providedAccessToken || await accessToken(config);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "developer-token": config.developerToken,
    };
    if (config.loginCustomerId) headers["login-customer-id"] = config.loginCustomerId;
    const response = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${config.customerId}:uploadClickConversions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ conversions: [conversion], partialFailure: true }),
        signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
      },
    );
    const body = await response.json().catch(() => null) as {
      partialFailureError?: { message?: unknown; details?: unknown };
      error?: { message?: unknown };
    } | null;
    const reason = typeof body?.partialFailureError?.message === "string"
      ? body.partialFailureError.message
      : typeof body?.error?.message === "string"
        ? body.error.message
        : undefined;
    return {
      success: response.ok && !body?.partialFailureError,
      statusCode: response.status,
      reason: response.ok && !body?.partialFailureError ? undefined : reason || `Google Ads HTTP ${response.status}`,
      ...(body?.partialFailureError
        ? { partialFailureCodes: readConversionUploadErrorCodes(body.partialFailureError) }
        : {}),
    };
  } catch (error) {
    return { success: false, reason: error instanceof Error ? error.message : "Google Ads network error" };
  }
}

/**
 * A candidate must carry a Google click identifier.
 *
 * This is not an optimisation. The scan is `ORDER BY o.id LIMIT n` over orders
 * that have no outbox row yet, and an order this query returns but
 * `buildGoogleClickConversion` refuses writes nothing — so it is still
 * unqueued on the next pass, and still first in line. Fifty organic delivered
 * COD orders, which is a normal week for a COD store, therefore fill the
 * window permanently and no Google-clicked order behind them is ever uploaded
 * again.
 *
 * TRACKING_SPECS §10 already states the rule — "Only orders with a stored
 * `gclid`, `gbraid`, or `wbraid` are queued" — it just lived in the builder
 * alone. Applying it here makes the candidate set and the builder agree, which
 * is what stops the head of the queue from blocking it.
 *
 * `ad_click_ids` is written by `serializeClickIds`, i.e. `JSON.stringify` of
 * validated `[A-Za-z0-9._-]` values: no spaces, and no value can contain a
 * quoted key, so this text match cannot be tripped by a click id's contents.
 */
const CLICK_IDENTITY_PREDICATE = `(
  o.ad_click_ids LIKE '%"gclid":"%'
  OR o.ad_click_ids LIKE '%"gbraid":"%'
  OR o.ad_click_ids LIKE '%"wbraid":"%'
)`;

export async function reconcileGoogleAdsConversions(
  database: D1Database,
  config: GoogleAdsOfflineConfig,
  observedAt = new Date(),
): Promise<number> {
  const paid = PAID_STATUSES.map(() => "?").join(", ");
  const result = await database.prepare(
    `SELECT o.id, o.order_number, o.payment_method, o.payment_status,
       o.shipping_status, o.created_at, o.ad_click_ids,
       COALESCE((SELECT SUM(oi.unit_price * oi.quantity) FROM order_items oi WHERE oi.order_id = o.id), 0) AS product_value
     FROM orders o
     LEFT JOIN google_ads_conversion_outbox g ON g.order_id = o.id
     WHERE g.order_id IS NULL
       AND o.created_at >= ?
       AND ${CLICK_IDENTITY_PREDICATE}
       AND ((o.payment_method = 'cod' AND o.shipping_status = 'delivered')
         OR (o.payment_method <> 'cod' AND o.payment_status IN (${paid})))
     ORDER BY o.id
     LIMIT ?`,
  ).bind(config.startAt, ...PAID_STATUSES, MAX_RECONCILE_BATCH).all<EligibleOrder>();

  let queued = 0;
  const now = observedAt.toISOString();
  for (const order of result.results || []) {
    const built = buildGoogleClickConversion(order, config, observedAt);
    if (!built) continue;
    const inserted = await database.prepare(
      `INSERT OR IGNORE INTO google_ads_conversion_outbox
       (order_id, order_number, qualification, payload, status, next_retry_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(
      order.id,
      order.order_number,
      built.qualification,
      JSON.stringify(built.conversion),
      now,
      now,
      now,
    ).run();
    if (inserted.meta?.changes) queued += 1;
  }
  return queued;
}

export async function drainGoogleAdsConversionOutbox(
  database: D1Database,
  config: GoogleAdsOfflineConfig,
): Promise<number> {
  const rows = await database.prepare(
    `SELECT id, payload, attempts, max_attempts
     FROM google_ads_conversion_outbox
     WHERE status = 'pending' AND next_retry_at <= ?
     ORDER BY id LIMIT ?`,
  ).bind(new Date().toISOString(), MAX_DRAIN_BATCH).all<OutboxRow>();
  if (!rows.results?.length) return 0;
  let sent = 0;
  let token: string;
  try {
    token = await accessToken(config);
  } catch {
    // One credential outage affects the whole batch. Leave rows pending rather
    // than spending every conversion's retry budget on the same shared failure.
    return 0;
  }
  for (const row of rows.results || []) {
    let conversion: GoogleClickConversion;
    try {
      conversion = JSON.parse(row.payload) as GoogleClickConversion;
    } catch {
      await database.prepare(
        `UPDATE google_ads_conversion_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      ).bind("payload tidak dapat dibaca", new Date().toISOString(), row.id).run();
      continue;
    }
    const outcome = await uploadGoogleClickConversion(conversion, config, token);
    // 401/403 from the Ads API is the account's answer, not this row's: an
    // unapproved developer token, a missing login-customer-id, a revoked
    // permission. Terminating per row spent ten conversions an hour on one
    // shared fault with no requeue path. Leave them pending — the stalled
    // queue raises the google-ads-outbox alert — and stop the batch.
    if (outcome.statusCode === 401 || outcome.statusCode === 403) {
      console.error("google-ads-offline-access-denied", {
        status: outcome.statusCode,
        reason: outcome.reason,
      });
      break;
    }
    const partial = outcome.partialFailureCodes
      ? classifyGooglePartialFailure(outcome.partialFailureCodes)
      : null;
    const decision = partial === "sent"
      ? { status: "sent" as const, delayMs: 0 }
      : partial === "terminal"
        ? { status: "failed" as const, delayMs: 0 }
        : partial === "retry-later" && row.attempts + 1 < row.max_attempts
          ? { status: "pending" as const, delayMs: 6 * 60 * 60_000 }
          : decideGoogleRetry(outcome.success, outcome.statusCode, row.attempts, row.max_attempts);
    const now = Date.now();
    await database.prepare(
      `UPDATE google_ads_conversion_outbox
       SET status = ?, attempts = attempts + ?, last_error = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      decision.status,
      decision.status === "sent" ? 0 : 1,
      decision.status === "sent" ? null : outcome.reason || "unknown",
      new Date(now + decision.delayMs).toISOString(),
      new Date(now).toISOString(),
      row.id,
    ).run();
    if (decision.status === "sent") sent += 1;
  }
  return sent;
}


/**
 * How much conversion signal Google is owed right now.
 *
 * The Google outbox had no health signal at all, which is precisely why a
 * head-of-line block in reconciliation stopped discovery entirely and nobody
 * saw it (`UNIMPLEMENTED_SPECS.md`, task A-227). Served by
 * `google_ads_conversion_outbox_due_idx (status, next_retry_at)`.
 *
 * Returns null when the table cannot be read, which the caller must report as
 * "unknown" rather than as a depth of zero.
 */
export async function readGoogleAdsOutboxDepth(
  database: D1Database,
  now = new Date(),
): Promise<GoogleAdsOutboxDepth | null> {
  try {
    const row = await database
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'failed' AND updated_at >= ? THEN 1 ELSE 0 END) AS recent_failed,
           SUM(CASE WHEN status = 'pending' AND next_retry_at <= ? THEN 1 ELSE 0 END) AS overdue,
           MIN(CASE WHEN status IN ('pending', 'failed') THEN created_at END) AS oldest_created_at
         FROM google_ads_conversion_outbox`,
      )
      .bind(new Date(now.getTime() - 24 * 60 * 60_000).toISOString(), now.toISOString())
      .first<{
        pending: number | null;
        failed: number | null;
        recent_failed: number | null;
        overdue: number | null;
        oldest_created_at: string | null;
      }>();
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      recentFailed: Number(row?.recent_failed ?? 0),
      overdue: Number(row?.overdue ?? 0),
      oldestCreatedAt: row?.oldest_created_at ?? null,
    };
  } catch (error) {
    console.error("google-ads-outbox-health-unreadable", error);
    return null;
  }
}

/**
 * Settled and terminal rows older than 30 days, the same retention the Meta
 * outbox keeps. The Google queue had none, so every delivered conversion stayed
 * forever and every health read scanned all of them.
 */
export async function purgeExpiredGoogleAdsConversions(database: D1Database, now = new Date()) {
  const result = await database
    .prepare(
      `DELETE FROM google_ads_conversion_outbox
        WHERE status IN ('sent', 'failed')
          AND unixepoch(updated_at) < unixepoch(?, '-30 days')`,
    )
    .bind(now.toISOString())
    .run();
  return result.meta.changes;
}
