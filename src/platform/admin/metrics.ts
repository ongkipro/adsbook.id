/**
 * The platform console's read models (UX-7…UX-9, T-52): business KPIs, the
 * action list, the Preview follow-up queue, the subscription calendar, the
 * cross-store invoice list, custom hosts and the audit feed. Control-plane
 * tables only (TEN-6) — never a tenant's orders, customers or credentials.
 *
 * Periods are WIB calendar periods (`Asia/Jakarta`, UTC+7, no DST): a "this
 * month" computed in UTC would be wrong for the first seven hours of every month.
 */
import { BILLING_CYCLES } from "../billing.ts";
import { platformHealth } from "./health.ts";

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** The UTC instant at which the WIB month containing `now` (shifted by `monthsBack`) starts. */
export function wibMonthStart(now: Date, monthsBack = 0): Date {
  const local = new Date(now.getTime() + WIB_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - monthsBack, 1) - WIB_OFFSET_MS);
}

/** `YYYY-MM-DD` of the WIB calendar day an instant falls on. */
export function wibDay(at: Date | string): string {
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Date(time + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

const dateFormat = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" });
const dateTimeFormat = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });

export function formatWibDate(iso: unknown): string {
  return typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? dateFormat.format(new Date(iso)) : "—";
}

export function formatWibDateTime(iso: unknown): string {
  return typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? dateTimeFormat.format(new Date(iso)) : "—";
}

/** "5 mnt", "3 jam", "2 hari" since an instant; "—" when unknown. */
export function ageText(iso: string | null | undefined, now = new Date()): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes} mnt`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} jam`;
  return `${Math.round(minutes / 1440)} hari`;
}

export type BillingFilter = "preview" | "subscribed" | "grace" | "expired";
export const BILLING_FILTERS: readonly BillingFilter[] = ["preview", "subscribed", "grace", "expired"];
export const BILLING_LABELS: Record<BillingFilter, string> = {
  preview: "Mode Preview",
  subscribed: "Aktif",
  grace: "Masa tenggang",
  expired: "Berakhir",
};

/** A wa.me link with an Indonesian greeting, or null when the owner gave no valid number. */
export function ownerWhatsAppLink(phone: string | null | undefined, slug: string): string | null {
  if (!phone || !/^62\d{8,13}$/.test(phone)) return null;
  const text = `Halo, saya dari adsbook.id. Terima kasih sudah membuat toko ${slug}. Ada yang bisa kami bantu supaya toko Anda siap jualan?`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

// A store pays while its days or its 48-hour grace run (demo excluded).
const PAYING = "t.is_demo = 0 AND t.status = 'active' AND t.subscription_ends_at IS NOT NULL AND t.grace_ends_at > ?1";

export type OverviewKpis = {
  payingStores: number;
  inGrace: number;
  collectedThisMonth: number;
  collectedLastMonth: number;
  estimatedMrr: number;
  everSubscribed: number;
  activated: number;
  signupsLast7Days: number;
};

/** UX-7 KPIs. Every number names its basis on screen; see DESIGN.md §6.1. */
export async function overviewKpis(platformDb: D1Database, now = new Date()): Promise<OverviewKpis> {
  const at = now.toISOString();
  const thisMonth = wibMonthStart(now).toISOString();
  const lastMonth = wibMonthStart(now, 1).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const [paying, money, mrr, funnel] = await Promise.all([
    platformDb
      .prepare(`SELECT COUNT(*) AS paying, SUM(CASE WHEN t.subscription_ends_at <= ?1 THEN 1 ELSE 0 END) AS grace FROM tenants t WHERE ${PAYING}`)
      .bind(at)
      .first<{ paying: number; grace: number | null }>(),
    platformDb
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN paid_at >= ?1 THEN total_idr END), 0) AS this_month,
           COALESCE(SUM(CASE WHEN paid_at >= ?2 AND paid_at < ?1 THEN total_idr END), 0) AS last_month
         FROM subscription_invoices WHERE status = 'paid' AND paid_at >= ?2`,
      )
      .bind(thisMonth, lastMonth)
      .first<{ this_month: number; last_month: number }>(),
    // Latest paid invoice per paying store, normalised to 30 days. A store on
    // granted days only has no paid invoice and counts 0.
    platformDb
      .prepare(
        `SELECT COALESCE(SUM((SELECT i.amount_idr * 30.0 / i.days FROM subscription_invoices i
            WHERE i.tenant_id = t.id AND i.status = 'paid' ORDER BY i.paid_at DESC, i.id DESC LIMIT 1)), 0) AS mrr
         FROM tenants t WHERE ${PAYING}`,
      )
      .bind(at)
      .first<{ mrr: number }>(),
    platformDb
      .prepare(
        `SELECT
           SUM(CASE WHEN status <> 'provisioning' THEN 1 ELSE 0 END) AS activated,
           SUM(CASE WHEN status <> 'provisioning' AND subscription_ends_at IS NOT NULL THEN 1 ELSE 0 END) AS ever_subscribed,
           SUM(CASE WHEN status <> 'provisioning' AND created_at >= ?1 THEN 1 ELSE 0 END) AS week
         FROM tenants WHERE is_demo = 0`,
      )
      .bind(weekAgo)
      .first<{ activated: number | null; ever_subscribed: number | null; week: number | null }>(),
  ]);
  return {
    payingStores: Number(paying?.paying ?? 0),
    inGrace: Number(paying?.grace ?? 0),
    collectedThisMonth: Number(money?.this_month ?? 0),
    collectedLastMonth: Number(money?.last_month ?? 0),
    estimatedMrr: Math.round(Number(mrr?.mrr ?? 0)),
    everSubscribed: Number(funnel?.ever_subscribed ?? 0),
    activated: Number(funnel?.activated ?? 0),
    signupsLast7Days: Number(funnel?.week ?? 0),
  };
}

export type ActionItem = { kind: string; label: string; tenantId: string | null; slug: string; detail: string; href: string };

/** UX-7 "Perlu tindakan": each row is something an operator should look at today. */
export async function actionItems(platformDb: D1Database, now = new Date()): Promise<ActionItem[]> {
  const at = now.toISOString();
  const week = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const [subscriptions, invoices, hosts, purges, health] = await Promise.all([
    platformDb
      .prepare(
        `SELECT t.id, t.slug, t.subscription_ends_at, t.grace_ends_at FROM tenants t
         WHERE ${PAYING} AND t.subscription_ends_at <= ?2 ORDER BY t.subscription_ends_at LIMIT 50`,
      )
      .bind(at, week)
      .all<{ id: string; slug: string; subscription_ends_at: string; grace_ends_at: string }>(),
    platformDb
      .prepare(
        `SELECT i.invoice_number, i.total_idr, i.created_at, t.id, t.slug FROM subscription_invoices i JOIN tenants t ON t.id = i.tenant_id
         WHERE i.status = 'pending' AND i.created_at < ?1 AND i.expires_at > ?2 ORDER BY i.created_at LIMIT 50`,
      )
      .bind(hourAgo, at)
      .all<{ invoice_number: string; total_idr: number; created_at: string; id: string; slug: string }>(),
    platformDb
      .prepare(
        `SELECT h.host, h.created_at, t.id, t.slug FROM tenant_hosts h JOIN tenants t ON t.id = h.tenant_id
         WHERE h.kind = 'custom' AND h.status = 'pending' AND h.created_at < ?1 ORDER BY h.created_at LIMIT 50`,
      )
      .bind(dayAgo)
      .all<{ host: string; created_at: string; id: string; slug: string }>(),
    platformDb
      .prepare("SELECT id, slug, purge_after FROM tenants WHERE purge_after IS NOT NULL AND status NOT IN ('purging', 'purged') ORDER BY purge_after LIMIT 50")
      .all<{ id: string; slug: string; purge_after: string }>(),
    platformHealth(platformDb, now),
  ]);
  const tenantHref = (id: string) => `/platform/tenants/${encodeURIComponent(id)}`;
  const items: ActionItem[] = [];
  for (const row of subscriptions.results) {
    const inGrace = row.subscription_ends_at <= at;
    items.push({
      kind: inGrace ? "grace" : "ending",
      label: inGrace ? "Masa tenggang" : "Langganan segera berakhir",
      tenantId: row.id,
      slug: row.slug,
      detail: inGrace ? `toko dijeda ${formatWibDateTime(row.grace_ends_at)}` : `berakhir ${formatWibDate(row.subscription_ends_at)}`,
      href: tenantHref(row.id),
    });
  }
  for (const row of invoices.results) {
    items.push({ kind: "invoice", label: "Tagihan menunggu > 1 jam", tenantId: row.id, slug: row.slug, detail: `${row.invoice_number} · dibuat ${ageText(row.created_at, now)} lalu`, href: `/platform/billing?status=pending&q=${encodeURIComponent(row.invoice_number)}` });
  }
  for (const row of hosts.results) {
    items.push({ kind: "domain", label: "Domain belum aktif > 24 jam", tenantId: row.id, slug: row.slug, detail: row.host, href: "/platform/domains?status=pending" });
  }
  for (const row of health.staleHeartbeats) {
    items.push({ kind: "heartbeat", label: "Heartbeat > 2 jam", tenantId: row.id, slug: row.slug, detail: row.heartbeat_at ? `terakhir ${ageText(row.heartbeat_at, now)} lalu` : "belum pernah", href: tenantHref(row.id) });
  }
  for (const row of health.unresolvedRecoveries) {
    items.push({ kind: "recovery", label: "Pemulihan owner tanpa hasil", tenantId: row.tenant_id, slug: row.slug ?? row.tenant_id, detail: formatWibDateTime(row.at), href: tenantHref(row.tenant_id) });
  }
  for (const row of purges.results) {
    items.push({ kind: "purge", label: "Penghapusan terjadwal", tenantId: row.id, slug: row.slug, detail: formatWibDate(row.purge_after), href: tenantHref(row.id) });
  }
  return items;
}

export type PreviewLead = { id: string; slug: string; owner_email: string; owner_whatsapp: string | null; created_at: string; primary_host: string | null };

/** UX-7 follow-up: active stores that never subscribed, newest first (the sales queue). */
export async function previewLeads(platformDb: D1Database, limit = 20): Promise<PreviewLead[]> {
  return (
    await platformDb
      .prepare(
        `SELECT t.id, t.slug, t.owner_email, t.owner_whatsapp, t.created_at,
           (SELECT host FROM tenant_hosts p WHERE p.tenant_id = t.id AND p.is_primary = 1) AS primary_host
         FROM tenants t WHERE t.is_demo = 0 AND t.status = 'active' AND t.subscription_ends_at IS NULL
         ORDER BY t.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<PreviewLead>()
  ).results;
}

export type DailyPoint = { day: string; signups: number; paid: number };

/** UX-7 chart: signups and paid invoices per WIB day for the last `days` days, oldest first, zero-filled. */
export async function dailySeries(platformDb: D1Database, now = new Date(), days = 30): Promise<DailyPoint[]> {
  const today = wibDay(now);
  const first = new Date(Date.parse(`${today}T00:00:00.000Z`) - (days - 1) * DAY_MS);
  const since = new Date(first.getTime() - WIB_OFFSET_MS).toISOString();
  const [signups, paid] = await Promise.all([
    platformDb
      .prepare("SELECT created_at AS at FROM tenants WHERE is_demo = 0 AND status <> 'provisioning' AND created_at >= ? LIMIT 20000")
      .bind(since)
      .all<{ at: string }>(),
    platformDb.prepare("SELECT paid_at AS at FROM subscription_invoices WHERE status = 'paid' AND paid_at >= ? LIMIT 20000").bind(since).all<{ at: string }>(),
  ]);
  const series = new Map<string, DailyPoint>();
  for (let index = 0; index < days; index += 1) {
    const day = new Date(first.getTime() + index * DAY_MS).toISOString().slice(0, 10);
    series.set(day, { day, signups: 0, paid: 0 });
  }
  for (const row of signups.results) {
    const point = series.get(wibDay(row.at));
    if (point) point.signups += 1;
  }
  for (const row of paid.results) {
    const point = series.get(wibDay(row.at));
    if (point) point.paid += 1;
  }
  return [...series.values()];
}

export type CalendarRow = { id: string; slug: string; subscription_ends_at: string; grace_ends_at: string };

/** UX-8 calendar: ending within 14 days, in grace now, expired within the last 30 days. */
export async function subscriptionWindows(platformDb: D1Database, now = new Date()) {
  const at = now.toISOString();
  const soon = new Date(now.getTime() + 14 * DAY_MS).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const rows = (
    await platformDb
      .prepare(
        `SELECT id, slug, subscription_ends_at, grace_ends_at FROM tenants
         WHERE is_demo = 0 AND status = 'active' AND subscription_ends_at IS NOT NULL
           AND subscription_ends_at <= ?1 AND grace_ends_at > ?2
         ORDER BY subscription_ends_at LIMIT 300`,
      )
      .bind(soon, monthAgo)
      .all<CalendarRow>()
  ).results;
  return {
    ending: rows.filter((row) => row.subscription_ends_at > at),
    grace: rows.filter((row) => row.subscription_ends_at <= at && row.grace_ends_at > at),
    expired: rows.filter((row) => row.grace_ends_at <= at),
  };
}

export type PlatformInvoiceRow = {
  id: string;
  invoice_number: string;
  tenant_id: string;
  slug: string | null;
  cycle_code: string;
  days: number;
  total_idr: number;
  channel_code: string;
  status: string;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
};

export const INVOICE_STATUSES = ["pending", "paid", "expired", "cancelled"] as const;
export const INVOICE_LIMIT = 200;

/** UX-8 invoice list across stores; search matches an invoice number or a store slug. */
export async function listPlatformInvoices(
  platformDb: D1Database,
  filter: { status?: string | null; search?: string | null } = {},
): Promise<PlatformInvoiceRow[]> {
  const status = filter.status && (INVOICE_STATUSES as readonly string[]).includes(filter.status) ? filter.status : null;
  const search = filter.search?.trim().slice(0, 100) || null;
  return (
    await platformDb
      .prepare(
        `SELECT i.id, i.invoice_number, i.tenant_id, t.slug, i.cycle_code, i.days, i.total_idr, i.channel_code, i.status, i.expires_at, i.paid_at, i.created_at
         FROM subscription_invoices i LEFT JOIN tenants t ON t.id = i.tenant_id
         WHERE (?1 IS NULL OR i.status = ?1)
           AND (?2 IS NULL OR i.invoice_number LIKE '%' || upper(?2) || '%' OR t.slug LIKE '%' || lower(?2) || '%')
         ORDER BY i.created_at DESC, i.id DESC LIMIT ${INVOICE_LIMIT}`,
      )
      .bind(status, search)
      .all<PlatformInvoiceRow>()
  ).results;
}

export async function invoiceTotals(platformDb: D1Database, now = new Date()) {
  const row = await platformDb
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ?1 THEN total_idr END), 0) AS this_month,
         COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ?2 AND paid_at < ?1 THEN total_idr END), 0) AS last_month,
         SUM(CASE WHEN status = 'pending' AND expires_at > ?3 THEN 1 ELSE 0 END) AS pending
       FROM subscription_invoices`,
    )
    .bind(wibMonthStart(now).toISOString(), wibMonthStart(now, 1).toISOString(), now.toISOString())
    .first<{ this_month: number; last_month: number; pending: number | null }>();
  return { thisMonth: Number(row?.this_month ?? 0), lastMonth: Number(row?.last_month ?? 0), pending: Number(row?.pending ?? 0) };
}

export type CustomHostRow = {
  host: string;
  tenant_id: string;
  slug: string;
  status: string;
  ssl_status: string | null;
  is_primary: number;
  created_at: string;
};

export const HOST_STATUSES = ["pending", "active", "revoked"] as const;

/** UX-9 domains: every custom host with its store, newest first. */
export async function listCustomHosts(platformDb: D1Database, filter: { status?: string | null } = {}): Promise<CustomHostRow[]> {
  const status = filter.status && (HOST_STATUSES as readonly string[]).includes(filter.status) ? filter.status : null;
  return (
    await platformDb
      .prepare(
        `SELECT h.host, h.tenant_id, t.slug, h.status, h.ssl_status, h.is_primary, h.created_at
         FROM tenant_hosts h JOIN tenants t ON t.id = h.tenant_id
         WHERE h.kind = 'custom' AND (?1 IS NULL OR h.status = ?1)
         ORDER BY h.created_at DESC LIMIT 200`,
      )
      .bind(status)
      .all<CustomHostRow>()
  ).results;
}

/** A custom host not active a day after it was added (UX-9 highlight). */
export function isStuckHost(row: Pick<CustomHostRow, "status" | "created_at">, now = new Date()): boolean {
  return row.status === "pending" && now.getTime() - Date.parse(row.created_at) > DAY_MS;
}

export type ActivityRow = { id: number; tenant_id: string; slug: string | null; kind: string; actor: string; at: string; detail_json: string | null };
export const ACTIVITY_PAGE = 100;

/** UX-9 audit feed: newest first, `before` is the id cursor of the previous page's last row. */
export async function listActivity(
  platformDb: D1Database,
  filter: { kind?: string | null; slug?: string | null; before?: number | null } = {},
): Promise<{ rows: ActivityRow[]; nextBefore: number | null }> {
  const kind = filter.kind && /^[a-z_]{1,60}$/.test(filter.kind) ? filter.kind : null;
  const slug = filter.slug?.trim().toLowerCase().slice(0, 64) || null;
  const before = Number.isInteger(filter.before) && Number(filter.before) > 0 ? Number(filter.before) : null;
  const rows = (
    await platformDb
      .prepare(
        `SELECT e.id, e.tenant_id, t.slug, e.kind, e.actor, e.at, e.detail_json
         FROM tenant_events e LEFT JOIN tenants t ON t.id = e.tenant_id
         WHERE (?1 IS NULL OR e.kind = ?1)
           AND (?2 IS NULL OR t.slug = ?2 OR (?2 = 'platform' AND e.tenant_id = '_platform'))
           AND (?3 IS NULL OR e.id < ?3)
         ORDER BY e.id DESC LIMIT ${ACTIVITY_PAGE + 1}`,
      )
      .bind(kind, slug, before)
      .all<ActivityRow>()
  ).results;
  const page = rows.slice(0, ACTIVITY_PAGE);
  return { rows: page, nextBefore: rows.length > ACTIVITY_PAGE ? page[page.length - 1].id : null };
}

export async function activityKinds(platformDb: D1Database): Promise<string[]> {
  return (await platformDb.prepare("SELECT DISTINCT kind FROM tenant_events ORDER BY kind LIMIT 100").all<{ kind: string }>()).results.map((row) => row.kind);
}

/** `platform:<user id>` → that user's email, for readable actors. */
export async function actorNames(platformDb: D1Database): Promise<Map<string, string>> {
  const users = (await platformDb.prepare("SELECT id, email FROM platform_users").all<{ id: string; email: string }>()).results;
  return new Map(users.map((user) => [`platform:${user.id}`, user.email]));
}

export const EVENT_LABELS: Record<string, string> = {
  signup: "Daftar",
  provision_failed: "Gagal dibuat",
  suspended: "Ditangguhkan",
  resumed: "Diaktifkan kembali",
  plan_changed: "Paket diubah",
  purge_requested: "Penghapusan dijadwalkan",
  purge_started: "Penghapusan dimulai",
  purge_completed: "Penghapusan selesai",
  purge_fenced: "Penghapusan ditahan",
  purged: "Dihapus",
  owner_recovery: "Kode pemulihan owner dibuat",
  owner_recovery_redeemed: "Kode pemulihan dipakai",
  owner_recovery_completed: "Pemulihan owner selesai",
  owner_recovery_failed: "Pemulihan owner gagal",
  subscription_paid: "Langganan dibayar",
  subscription_granted: "Langganan diberikan",
  migration_failed: "Migrasi gagal",
  platform_user_added: "Pengguna platform ditambah",
  platform_user_disabled: "Pengguna platform dinonaktifkan",
  platform_user_enabled: "Pengguna platform diaktifkan",
  platform_user_role_changed: "Peran pengguna platform diubah",
  platform_user_reset: "Akses pengguna platform direset",
};

/** One readable line from an event's detail; keys it does not know are left out (never a secret). */
export function describeEvent(detailJson: string | null): string {
  if (!detailJson) return "";
  let detail: Record<string, unknown>;
  try {
    detail = JSON.parse(detailJson) as Record<string, unknown>;
  } catch {
    return "";
  }
  const parts: string[] = [];
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
  const WORDS: Record<string, string> = {
    platform_owner: "Owner", platform_support: "Support", active: "aktif", disabled: "nonaktif", suspended: "ditangguhkan",
    access: "akses lama", reset: "akses baru",
  };
  const word = (value: unknown) => WORDS[text(value)] ?? text(value);
  if (detail.invoice) parts.push(text(detail.invoice));
  if (detail.cycle) parts.push((BILLING_CYCLES as Record<string, { label: string }>)[text(detail.cycle)]?.label ?? `paket ${text(detail.cycle)}`);
  if (detail.days) parts.push(`${text(detail.days)} hari`);
  if (typeof detail.total_idr === "number") parts.push(`Rp${detail.total_idr.toLocaleString("id-ID")}`);
  if (detail.channel) parts.push(text(detail.channel));
  if (detail.email) parts.push(text(detail.email));
  if (detail.role) parts.push(word(detail.role));
  if (detail.host) parts.push(text(detail.host));
  if (detail.step) parts.push(`langkah ${text(detail.step)}`);
  if (typeof detail.before === "string" && typeof detail.after === "string") parts.push(`${word(detail.before)} → ${word(detail.after)}`);
  if (detail.reason) parts.push(`alasan: ${text(detail.reason)}`);
  return parts.filter(Boolean).join(" · ").slice(0, 300);
}

/** UX-4 detail: a store's request/order/media totals over the last 30 days. */
export async function tenantUsage30d(platformDb: D1Database, tenantId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10);
  const row = await platformDb
    .prepare(
      `SELECT COALESCE(SUM(orders), 0) AS orders, COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(media_bytes), 0) AS media_bytes, COUNT(*) AS days
       FROM tenant_usage_daily WHERE tenant_id = ? AND day >= ?`,
    )
    .bind(tenantId, since)
    .first<{ orders: number; requests: number; media_bytes: number; days: number }>();
  return { orders: Number(row?.orders ?? 0), requests: Number(row?.requests ?? 0), mediaBytes: Number(row?.media_bytes ?? 0), days: Number(row?.days ?? 0) };
}
