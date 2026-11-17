/**
 * Subscription billing (ADR-041, T-49, PR-31): Option A cycles, the billing
 * state of a store, and the platform's own AutoLaris rail.
 *
 * Isolation (BILL-3, TEN-4): this module reads only the platform's secrets
 * (`PLATFORM_AUTOLARIS_*`) and only `PLATFORM_DB`. It never reads a tenant's
 * `stores.autolaris_api_key` and never touches a buyer's order or payment row.
 *
 * Settlement (ADR-022): a callback is evidence only. An invoice becomes paid
 * when AutoLaris Advice reports an explicit settlement for its provider
 * transaction (`AutoLarisClient.inquirePayment`, the same conservative reading
 * the stores use), or when a `platform_owner` grants days by hand (BILL-7).
 * The days are credited in the same D1 batch that marks the invoice paid, and
 * only by the settlement that won that transition (`settlement_id`), so a
 * replayed webhook, a second cron run or a double click never credits twice.
 */
import { AutoLarisClient, parseAutoLarisPaymentResponse } from "../lib/autolaris-client.ts";
import { sha256Hex } from "../lib/meta-identity.ts";
import { notifyOperator } from "./notify.ts";
import { constantTimeEqual } from "./webhook-secrets.ts";

export type CycleCode = "1m" | "3m" | "6m" | "12m";

/** Option A, per store (one store = one custom domain). Integer IDR. */
export const BILLING_CYCLES: Readonly<Record<CycleCode, { days: number; amountIdr: number; label: string }>> = {
  "1m": { days: 30, amountIdr: 149_000, label: "1 Bulan" },
  "3m": { days: 90, amountIdr: 399_000, label: "3 Bulan" },
  "6m": { days: 180, amountIdr: 759_000, label: "6 Bulan" },
  "12m": { days: 365, amountIdr: 1_490_000, label: "1 Tahun" },
};

export const GRACE_HOURS = 48;
/** How long one QRIS/VA instruction stays payable. */
export const INVOICE_TTL_MS = 24 * 60 * 60 * 1000;
/** An expired or replaced instruction can still be paid late; Advice keeps asking this long. */
export const LATE_PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000;

export function isCycleCode(value: unknown): value is CycleCode {
  return typeof value === "string" && Object.hasOwn(BILLING_CYCLES, value);
}

export type BillingState = "preview" | "subscribed" | "grace" | "expired";

/** BILL-5: the state of an active store, from its two control-plane timestamps. */
export function billingState(
  tenant: { subscriptionEndsAt?: string | null; graceEndsAt?: string | null },
  now: Date,
): BillingState {
  const ends = tenant.subscriptionEndsAt ? Date.parse(tenant.subscriptionEndsAt) : NaN;
  if (!Number.isFinite(ends)) return "preview";
  const at = now.getTime();
  if (at < ends) return "subscribed";
  const grace = tenant.graceEndsAt ? Date.parse(tenant.graceEndsAt) : ends + GRACE_HOURS * 3_600_000;
  return at < grace ? "grace" : "expired";
}

/** Checkout, ad signals, AI and custom domains run only while this holds. */
export function isLive(state: BillingState): boolean {
  return state === "subscribed" || state === "grace";
}

export const BILLING_MESSAGES = {
  preview: "Toko masih Mode Preview. Aktifkan langganan di Admin → Langganan agar toko bisa menerima pesanan dan diiklankan.",
  expired: "Langganan toko sudah berakhir. Perpanjang di Admin → Langganan untuk membuka kembali pesanan; semua data toko tetap aman.",
} as const;

/** What a buyer reads in the order form of a store that is not live: no admin talk, no blame. */
export const BUYER_CLOSED_MESSAGE = "Toko ini belum menerima pesanan. Silakan hubungi penjual atau coba lagi nanti.";

/**
 * Buyer order entry points (ADR-041 §3.2) and the anonymous shipping quotes in
 * front of them. Every other public page keeps rendering, with a banner.
 */
const LIVE_ONLY_PUBLIC = new Set([
  "/api/submit-order",
  "/api/submit-middle-order",
  "/api/record-abandoned-order",
  "/api/v1/checkout",
  "/api/shipping-rates",
  "/api/shipping-options",
]);

/** Admin writes that need a live subscription: claiming a custom domain. */
function liveOnlyAdmin(path: string, method: string): boolean {
  return method === "POST" && path === "/api/admin/domains";
}

export function subscriptionRefusalBody(state: BillingState) {
  const expired = state === "expired";
  return {
    success: false,
    error: expired ? BILLING_MESSAGES.expired : BILLING_MESSAGES.preview,
    code: expired ? "SUBSCRIPTION_EXPIRED" : "SUBSCRIPTION_REQUIRED",
    // The order forms show this one to the buyer; `error` stays for the seller and API clients.
    buyer_message: BUYER_CLOSED_MESSAGE,
  };
}

/** The refusal for a request a non-live store may not serve, or null. */
export function subscriptionRefusal(pathname: string, method: string, state: BillingState): Response | null {
  if (isLive(state)) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const verb = method.toUpperCase();
  const blocked = LIVE_ONLY_PUBLIC.has(path) ? verb !== "GET" && verb !== "HEAD" || path.startsWith("/api/shipping-") : liveOnlyAdmin(path, verb);
  if (!blocked) return null;
  return new Response(JSON.stringify(subscriptionRefusalBody(state)), {
    status: 402,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ── Platform AutoLaris rail ─────────────────────────────────────────────────

export type BillingEnv = Record<string, unknown> & {
  PLATFORM_AUTOLARIS_API_KEY?: unknown;
  PLATFORM_AUTOLARIS_BASE_URL?: unknown;
  PLATFORM_AUTOLARIS_WEBHOOK_TOKEN?: unknown;
  PLATFORM_SITE_URL?: unknown;
};

const DEFAULT_AUTOLARIS_BASE = "https://api-h2h.autolaris.com";

function platformRail(env: BillingEnv | null | undefined): { key: string; base: string } | null {
  const key = typeof env?.PLATFORM_AUTOLARIS_API_KEY === "string" ? env.PLATFORM_AUTOLARIS_API_KEY.trim() : "";
  if (!key) return null;
  const base = typeof env?.PLATFORM_AUTOLARIS_BASE_URL === "string" && env.PLATFORM_AUTOLARIS_BASE_URL.trim()
    ? env.PLATFORM_AUTOLARIS_BASE_URL.trim().replace(/\/+$/, "")
    : DEFAULT_AUTOLARIS_BASE;
  return { key, base };
}

export function billingConfigured(env: BillingEnv | null | undefined): boolean {
  return platformRail(env) !== null;
}

/** QRIS and bank virtual accounts only (ADR-041): no COD, no e-wallet redirect. */
export function isBillingChannel(code: string): boolean {
  return code === "QRIS" || /^VA[A-Z]{2,12}$/.test(code);
}

export type BillingChannel = { code: string; name: string; fee: number; feeType: "fix" | "persen" };

/** Live channel list of the platform account (`GET /api/h2h/list_payment`). */
export async function listBillingChannels(env: BillingEnv, fetcher: typeof fetch = fetch): Promise<BillingChannel[]> {
  const rail = platformRail(env);
  if (!rail) return [];
  const response = await fetcher(`${rail.base}/api/h2h/list_payment`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${rail.key}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => null)) as { rc?: string; data?: unknown } | null;
  if (!response.ok || payload?.rc !== "00" || !Array.isArray(payload.data)) {
    throw new Error("Daftar metode pembayaran tidak bisa dibaca saat ini.");
  }
  return (payload.data as { channel_code?: unknown; name?: unknown; admin?: unknown; tipe_admin?: unknown }[])
    .map((row) => ({
      code: String(row.channel_code ?? "").trim().toUpperCase(),
      name: String(row.name ?? "").trim(),
      fee: Number(row.admin ?? 0) || 0,
      feeType: row.tipe_admin === "persen" ? ("persen" as const) : ("fix" as const),
    }))
    .filter((row) => row.code && isBillingChannel(row.code));
}

/** `YYYYMMDDHHMMSS` in Jakarta time, as the provider's examples show. */
export function autoLarisExpiry(at: Date): string {
  const jakarta = new Date(at.getTime() + 7 * 3_600_000).toISOString();
  return jakarta.slice(0, 19).replace(/[-:T]/g, "");
}

export type InvoiceRow = {
  id: string;
  invoice_number: string;
  tenant_id: string;
  cycle_code: CycleCode;
  days: number;
  amount_idr: number;
  admin_fee_idr: number;
  total_idr: number;
  channel_code: string;
  provider_trx_id: string | null;
  qr_payload: string | null;
  virtual_account: string | null;
  payment_url: string | null;
  status: "pending" | "paid" | "expired" | "cancelled";
  expires_at: string;
  paid_at: string | null;
  created_at: string;
};

const INVOICE_COLUMNS = `id, invoice_number, tenant_id, cycle_code, days, amount_idr, admin_fee_idr, total_idr, channel_code,
  provider_trx_id, qr_payload, virtual_account, payment_url, status, expires_at, paid_at, created_at`;

export async function listInvoices(platformDb: D1Database, tenantId: string, limit = 20): Promise<InvoiceRow[]> {
  return (
    await platformDb
      .prepare(`SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(tenantId, limit)
      .all<InvoiceRow>()
  ).results;
}

export async function loadInvoice(platformDb: D1Database, tenantId: string, invoiceId: string): Promise<InvoiceRow | null> {
  return platformDb
    .prepare(`SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE id = ? AND tenant_id = ?`)
    .bind(invoiceId, tenantId)
    .first<InvoiceRow>();
}

function randomCode(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export type BillingResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/**
 * One payment instruction for one cycle. The row (and its `invoice_number`,
 * the provider `reff_id`) is written before the provider call, as AutoLaris
 * requires; the provider transaction id is stored with the instruction.
 */
export async function createInvoice(
  platformDb: D1Database,
  env: BillingEnv,
  input: {
    tenantId: string;
    cycle: unknown;
    channel: unknown;
    customer: { name: string; email: string; phone: string };
  },
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<BillingResult<InvoiceRow>> {
  const rail = platformRail(env);
  if (!rail) return { ok: false, status: 503, error: "Pembayaran langganan belum tersedia. Hubungi admin adsbook.id." };
  if (!isCycleCode(input.cycle)) return { ok: false, status: 422, error: "Pilih paket langganan." };
  const channel = typeof input.channel === "string" ? input.channel.trim().toUpperCase() : "";
  let channels: BillingChannel[];
  try {
    channels = await listBillingChannels(env, fetcher);
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : "Metode pembayaran tidak tersedia." };
  }
  if (!channels.some((row) => row.code === channel)) return { ok: false, status: 422, error: "Metode pembayaran tidak tersedia." };

  const cycle = BILLING_CYCLES[input.cycle];
  const id = `inv_${crypto.randomUUID().replace(/-/g, "")}`;
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const invoiceNumber = `ADB-${day}-${randomCode(8)}`;
  const expiresAt = new Date(now.getTime() + INVOICE_TTL_MS);
  await platformDb
    .prepare(
      `INSERT INTO subscription_invoices (id, invoice_number, tenant_id, cycle_code, days, amount_idr, total_idr, channel_code, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(id, invoiceNumber, input.tenantId, input.cycle, cycle.days, cycle.amountIdr, cycle.amountIdr, channel, expiresAt.toISOString(), now.toISOString())
    .run();

  const token = typeof env.PLATFORM_AUTOLARIS_WEBHOOK_TOKEN === "string" ? env.PLATFORM_AUTOLARIS_WEBHOOK_TOKEN.trim() : "";
  const site = typeof env.PLATFORM_SITE_URL === "string" && env.PLATFORM_SITE_URL.trim() ? env.PLATFORM_SITE_URL.trim().replace(/\/+$/, "") : "https://adsbook.id";
  try {
    const response = await fetcher(`${rail.base}/api/h2h/create_payment`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${rail.key}` },
      body: JSON.stringify({
        reff_id: invoiceNumber,
        channel_code: channel,
        customer_id: input.tenantId,
        customer_name: input.customer.name.slice(0, 80),
        customer_phone: input.customer.phone,
        customer_email: input.customer.email,
        expired: autoLarisExpiry(expiresAt),
        amount: String(cycle.amountIdr),
        callback_url: token ? `${site}/api/platform/webhooks/autolaris/${token}` : "",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    const payment = parseAutoLarisPaymentResponse(payload, cycle.amountIdr);
    if (payment.amount !== cycle.amountIdr || payment.total < cycle.amountIdr) {
      throw new Error("AutoLaris mengembalikan nominal yang tidak sesuai.");
    }
    await platformDb
      .prepare(
        `UPDATE subscription_invoices SET provider_trx_id = ?, qr_payload = ?, virtual_account = ?, payment_url = ?,
           admin_fee_idr = ?, total_idr = ? WHERE id = ?`,
      )
      .bind(payment.transactionId, payment.qr ?? null, payment.virtualAccount ?? null, payment.url ?? null, Math.round(payment.admin), Math.round(payment.total), id)
      .run();
  } catch (error) {
    // lazy: an unknown outcome (timeout after the provider created it) leaves no
    // transaction id to ask Advice about; the instruction is cancelled locally and
    // a payment against it needs a manual grant. Upgrade: look it up by reff_id
    // if AutoLaris publishes such a read.
    await platformDb.prepare("UPDATE subscription_invoices SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(id).run();
    console.error("platform-billing-create-failed", { tenant_id: input.tenantId, channel, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return { ok: false, status: 502, error: "Tagihan belum bisa dibuat. Coba lagi beberapa saat atau pilih metode lain." };
  }
  // One open instruction per store: older pending ones are withdrawn here, and
  // Advice keeps asking about them for LATE_PAYMENT_WINDOW_MS in case one is paid.
  await platformDb
    .prepare("UPDATE subscription_invoices SET status = 'cancelled' WHERE tenant_id = ? AND status = 'pending' AND id <> ?")
    .bind(input.tenantId, id)
    .run();
  const row = await loadInvoice(platformDb, input.tenantId, id);
  return row ? { ok: true, value: row } : { ok: false, status: 500, error: "Tagihan tidak ditemukan." };
}

/**
 * SQL for "extend from MAX(now, current end) by N days", with the 48-hour
 * grace. `?1` is now (ISO, UTC); `days` is an SQL expression. Early renewal
 * keeps every remaining day; a lapsed store restarts from now.
 */
function extendSet(days: string): string {
  const from = "MAX(?1, COALESCE(subscription_ends_at, ?1))";
  return `subscription_ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', ${from}, '+' || ${days} || ' days'),
    grace_ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', ${from}, '+' || ${days} || ' days', '+${GRACE_HOURS} hours'),
    cache_version = cache_version + 1`;
}

/**
 * Credit an invoice once. The invoice transition and the tenant extension are
 * one batch, and the extension is conditioned on this call's settlement id
 * being the one stored, so only the call that moved the invoice to `paid`
 * extends the store.
 */
export async function settleInvoice(
  platformDb: D1Database,
  invoiceId: string,
  settledBy: "advice",
  now = new Date(),
): Promise<"credited" | "already-paid" | "not-found"> {
  const settlement = crypto.randomUUID();
  const at = now.toISOString();
  // ?1 now, ?2 settlement id, ?3 how, ?4 invoice id.
  const won = "EXISTS (SELECT 1 FROM subscription_invoices WHERE id = ?4 AND settlement_id = ?2)";
  const results = await platformDb.batch([
    platformDb
      .prepare(
        `UPDATE subscription_invoices SET status = 'paid', paid_at = ?1, settlement_id = ?2, settled_by = ?3
         WHERE id = ?4 AND status <> 'paid' AND settlement_id IS NULL`,
      )
      .bind(at, settlement, settledBy, invoiceId),
    platformDb
      .prepare(
        `UPDATE tenants SET ${extendSet("(SELECT days FROM subscription_invoices WHERE id = ?4)")}
         WHERE id = (SELECT tenant_id FROM subscription_invoices WHERE id = ?4) AND ${won}`,
      )
      .bind(at, settlement, settledBy, invoiceId),
    platformDb
      .prepare(
        `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
         SELECT tenant_id, 'subscription_paid', 'platform-billing', ?1,
           json_object('invoice', invoice_number, 'cycle', cycle_code, 'days', days, 'total_idr', total_idr, 'channel', channel_code, 'by', ?3)
         FROM subscription_invoices WHERE id = ?4 AND settlement_id = ?2`,
      )
      .bind(at, settlement, settledBy, invoiceId),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 1) return "credited";
  const exists = await platformDb.prepare("SELECT status FROM subscription_invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>();
  return exists ? "already-paid" : "not-found";
}

/**
 * BILL-7: a `platform_owner` grants days by hand (pilot, internal store, or a
 * payment proven outside Advice), with a reason, in one batch with its audit.
 * The caller enforces the role.
 */
export async function grantSubscription(
  platformDb: D1Database,
  input: { tenantId: string; days: unknown; reason: unknown; actor: string },
  now = new Date(),
): Promise<BillingResult<{ subscriptionEndsAt: string }>> {
  const days = Number(input.days);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!Number.isInteger(days) || days < 1 || days > 730) return { ok: false, status: 422, error: "Jumlah hari 1–730." };
  if (reason.length < 5 || reason.length > 300) return { ok: false, status: 422, error: "Alasan wajib diisi (5–300 karakter)." };
  const at = now.toISOString();
  const results = await platformDb.batch([
    platformDb.prepare(`UPDATE tenants SET ${extendSet("?2")} WHERE id = ?3 AND status = 'active'`).bind(at, days, input.tenantId),
    platformDb
      .prepare(
        `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
         SELECT id, 'subscription_granted', ?4, ?1, json_object('days', ?2, 'reason', ?5, 'ends_at', subscription_ends_at)
         FROM tenants WHERE id = ?3 AND status = 'active'`,
      )
      .bind(at, days, input.tenantId, input.actor, reason),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) return { ok: false, status: 409, error: "Hanya toko aktif yang bisa diberi langganan." };
  const row = await platformDb.prepare("SELECT subscription_ends_at FROM tenants WHERE id = ?").bind(input.tenantId).first<{ subscription_ends_at: string }>();
  return { ok: true, value: { subscriptionEndsAt: String(row?.subscription_ends_at ?? "") } };
}

export type CheckOutcome = "credited" | "already-paid" | "pending" | "unproven" | "no-transaction" | "unavailable";

/** Ask Advice about one invoice and settle it when, and only when, it says paid. */
export async function checkInvoice(platformDb: D1Database, env: BillingEnv, invoice: InvoiceRow, now = new Date()): Promise<CheckOutcome> {
  if (invoice.status === "paid") return "already-paid";
  if (!invoice.provider_trx_id) return "no-transaction";
  const rail = platformRail(env);
  if (!rail) return "unavailable";
  const inquiry = await new AutoLarisClient(rail.key, rail.base).inquirePayment(invoice.provider_trx_id);
  await platformDb.prepare("UPDATE subscription_invoices SET last_checked_at = ? WHERE id = ?").bind(now.toISOString(), invoice.id).run();
  if (inquiry.settlement === "paid") {
    const settled = await settleInvoice(platformDb, invoice.id, "advice", now);
    if (settled === "credited") {
      const tenant = await platformDb.prepare("SELECT slug FROM tenants WHERE id = ?").bind(invoice.tenant_id).first<{ slug: string }>();
      await notifyOperator(env, platformDb, { tenantId: invoice.tenant_id, slug: tenant?.slug ?? invoice.tenant_id, kind: "subscription_paid", onceKey: invoice.invoice_number });
    }
    return settled === "not-found" ? "unavailable" : settled;
  }
  if (inquiry.settlement === "unproven") {
    // Evidence, not a transition (ADR-022): kept in the logs for the operator.
    console.error("platform-billing-advice-unproven", { invoice: invoice.invoice_number, code: inquiry.code, status: inquiry.status.slice(0, 60) });
    return "unproven";
  }
  return "pending";
}

/**
 * The cron leg and the webhook's target: open instructions, plus withdrawn or
 * expired ones still inside the late-payment window, oldest first, bounded.
 * Then pending instructions past their expiry are marked expired.
 */
export async function pollOpenInvoices(
  platformDb: D1Database,
  env: BillingEnv,
  now = new Date(),
  options: { limit?: number; tenantId?: string } = {},
): Promise<{ checked: number; credited: number }> {
  if (!billingConfigured(env)) return { checked: 0, credited: 0 };
  const lateFloor = new Date(now.getTime() - LATE_PAYMENT_WINDOW_MS).toISOString();
  const rows = (
    await platformDb
      .prepare(
        `SELECT ${INVOICE_COLUMNS} FROM subscription_invoices
         WHERE provider_trx_id IS NOT NULL AND paid_at IS NULL
           AND (status = 'pending' OR (status IN ('expired', 'cancelled') AND (
             expires_at >= ?
             -- One last look after the late window closes, so a backlog never drops an unseen payment.
             OR last_checked_at IS NULL
             OR last_checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+${LATE_PAYMENT_WINDOW_MS / 3_600_000} hours'))))
           ${options.tenantId ? "AND tenant_id = ?" : ""}
         -- Never-asked first, then the least recently asked: a bounded run rotates through the backlog.
         ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC, created_at ASC LIMIT ?`,
      )
      .bind(...(options.tenantId ? [lateFloor, options.tenantId, options.limit ?? 25] : [lateFloor, options.limit ?? 25]))
      .all<InvoiceRow>()
  ).results;
  let credited = 0;
  for (const row of rows) {
    try {
      if ((await checkInvoice(platformDb, env, row, now)) === "credited") credited += 1;
    } catch (error) {
      console.error("platform-billing-check-failed", { invoice: row.invoice_number, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    }
  }
  await platformDb
    .prepare("UPDATE subscription_invoices SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
    .bind(now.toISOString())
    .run();
  return { checked: rows.length, credited };
}

/**
 * `POST /api/platform/webhooks/autolaris/<token>` (API-9). The token is the
 * platform secret, compared in constant time; a wrong one is a plain 404. The
 * body is evidence only (its contract is unpublished): it may name the
 * provider transaction or our reff_id, which narrows the Advice check;
 * otherwise the open instructions are checked, bounded. Nothing in the body
 * ever marks an invoice paid.
 */
export async function handleBillingWebhook(
  platformDb: D1Database,
  env: BillingEnv,
  token: string,
  body: unknown,
  now = new Date(),
): Promise<{ status: number; checked: number; credited: number }> {
  const expected = typeof env.PLATFORM_AUTOLARIS_WEBHOOK_TOKEN === "string" ? env.PLATFORM_AUTOLARIS_WEBHOOK_TOKEN.trim() : "";
  if (expected.length < 32 || !constantTimeEqual(await sha256Hex(token), await sha256Hex(expected))) {
    return { status: 404, checked: 0, credited: 0 };
  }
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested = fields.data && typeof fields.data === "object" ? (fields.data as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields[key] ?? nested[key];
      if (typeof value === "string" || typeof value === "number") return String(value).trim().slice(0, 64);
    }
    return "";
  };
  const trx = pick("trx_id", "transaction_id");
  const reff = pick("reff_id");
  const target = trx || reff
    ? await platformDb
        .prepare(`SELECT ${INVOICE_COLUMNS} FROM subscription_invoices WHERE (provider_trx_id = ? AND ? <> '') OR (invoice_number = ? AND ? <> '') LIMIT 1`)
        .bind(trx, trx, reff, reff)
        .first<InvoiceRow>()
    : null;
  if (target) {
    const outcome = await checkInvoice(platformDb, env, target, now);
    return { status: 200, checked: 1, credited: outcome === "credited" ? 1 : 0 };
  }
  const polled = await pollOpenInvoices(platformDb, env, now, { limit: 10 });
  return { status: 200, ...polled };
}

/**
 * Operator notices (PR-29) for the subscription calendar, once per end date:
 * three days before it, and when a store enters its 48-hour grace. Bounded.
 */
export async function subscriptionCalendar(
  platformDb: D1Database,
  now = new Date(),
  limit = 50,
): Promise<{ ending: { tenantId: string; slug: string; endsAt: string }[]; grace: { tenantId: string; slug: string; endsAt: string }[] }> {
  const at = now.toISOString();
  const soon = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  const rows = (
    await platformDb
      .prepare(
        `SELECT id, slug, subscription_ends_at, grace_ends_at FROM tenants
         WHERE status = 'active' AND is_demo = 0 AND subscription_ends_at IS NOT NULL
           AND subscription_ends_at <= ? AND grace_ends_at > ?
         ORDER BY subscription_ends_at LIMIT ?`,
      )
      .bind(soon, at, limit)
      .all<{ id: string; slug: string; subscription_ends_at: string; grace_ends_at: string }>()
  ).results;
  const ending = rows.filter((row) => row.subscription_ends_at > at).map((row) => ({ tenantId: row.id, slug: row.slug, endsAt: row.subscription_ends_at }));
  const grace = rows.filter((row) => row.subscription_ends_at <= at).map((row) => ({ tenantId: row.id, slug: row.slug, endsAt: row.subscription_ends_at }));
  return { ending, grace };
}
