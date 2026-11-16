/**
 * Operator notifications (T-44, PR-29): a seller signed up, a store became
 * ready, a custom domain became active or is still failing after 24 hours,
 * a store took its first order. Sent to the same channel as the platform
 * alerts (OBS-4): the platform secret `PLATFORM_ALERT_WEBHOOK_URL`, with the
 * `{ text, content }` body of `alertWebhookBody` (`src/lib/operational-alerts.ts`),
 * so Telegram, Slack and Discord webhooks all read it.
 *
 * Each notice names the store, its slug and the platform admin link, and
 * never a buyer field (PRIV-1). Each is sent once: `operator_notices` claims
 * (tenant, notice) before the post; a failed post is logged, not retried.
 */

/** T-44: after a domain refresh — a custom domain now active is announced once. */
export function noticeDomainIfActive(
  env: Record<string, unknown> | null | undefined,
  platformDb: D1Database,
  tenant: { tenantId: string; slug: string; storeName?: string | null },
  domain: { host: string; kind: string; status: string },
  waitUntil?: (task: Promise<unknown>) => void,
): void {
  if (domain.kind !== "custom" || domain.status !== "active") return;
  const task = notifyOperator(env, platformDb, { ...tenant, kind: "domain_active", host: domain.host });
  if (waitUntil) waitUntil(task);
}

/**
 * T-44: custom domains still pending 24 hours after they were added, each
 * announced once (from the platform cron). Bounded per run.
 */
export async function noticeStuckDomains(env: Record<string, unknown> | null | undefined, platformDb: D1Database, now: Date, limit = 50): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const rows = (
    await platformDb
      .prepare(
        `SELECT h.host, h.tenant_id, t.slug FROM tenant_hosts h JOIN tenants t ON t.id = h.tenant_id
         WHERE h.kind = 'custom' AND h.status = 'pending' AND h.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM operator_notices n WHERE n.tenant_id = h.tenant_id AND n.notice = 'domain_failed:' || h.host)
         ORDER BY h.created_at LIMIT ?`,
      )
      .bind(since, limit)
      .all<{ host: string; tenant_id: string; slug: string }>()
  ).results;
  let sent = 0;
  for (const row of rows) {
    if ((await notifyOperator(env, platformDb, { tenantId: row.tenant_id, slug: row.slug, kind: "domain_failed", host: row.host }, fetch, now)) === "sent") sent += 1;
  }
  return sent;
}

export type NoticeKind = "signup" | "ready" | "domain_active" | "domain_failed" | "first_order" | "subscription_paid" | "subscription_ending" | "subscription_grace";

const LABELS: Record<NoticeKind, string> = {
  signup: "Seller baru mendaftar",
  ready: "Toko siap jualan",
  domain_active: "Domain sendiri aktif",
  domain_failed: "Domain sendiri belum aktif setelah 24 jam",
  first_order: "Pesanan pertama toko",
  subscription_paid: "Langganan toko dibayar",
  subscription_ending: "Langganan toko berakhir dalam 3 hari",
  subscription_grace: "Langganan toko lewat jatuh tempo (masa tenggang 48 jam)",
};

export type Notice = {
  tenantId: string;
  slug: string;
  kind: NoticeKind;
  /** The store's own name when the caller knows it; the slug otherwise. */
  storeName?: string | null;
  /** The domain, for the two domain notices (one notice per host). */
  host?: string;
  /** Makes a recurring notice once per occurrence (a subscription's end date). */
  onceKey?: string;
};

/** The webhook, only when it is an https URL; anything else sends nothing. */
function webhookUrl(env: Record<string, unknown> | null | undefined): string | null {
  const value = typeof env?.PLATFORM_ALERT_WEBHOOK_URL === "string" ? env.PLATFORM_ALERT_WEBHOOK_URL.trim() : "";
  try {
    return value && new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function adminLink(env: Record<string, unknown> | null | undefined, tenantId: string): string {
  const base = typeof env?.PLATFORM_ADMIN_URL === "string" && env.PLATFORM_ADMIN_URL.trim() ? env.PLATFORM_ADMIN_URL.trim() : "https://app.adsbook.id";
  return `${base.replace(/\/+$/, "")}/platform/tenants/${encodeURIComponent(tenantId)}`;
}

/** The notice text: label, store, slug, domain and the admin link — nothing else. */
export function noticeText(env: Record<string, unknown> | null | undefined, notice: Notice): string {
  const name = notice.storeName?.trim() || notice.slug;
  const domain = notice.host ? ` · ${notice.host}` : "";
  return `[adsbook.id] ${LABELS[notice.kind]}: ${name} (${notice.slug})${domain} — ${adminLink(env, notice.tenantId)}`;
}

/**
 * Send one notice, once. Never throws: a notification must not touch the
 * request or job that triggered it.
 */
export async function notifyOperator(
  env: Record<string, unknown> | null | undefined,
  platformDb: D1Database,
  notice: Notice,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<"sent" | "duplicate" | "skipped" | "failed"> {
  const key = notice.host ? `${notice.kind}:${notice.host}` : notice.onceKey ? `${notice.kind}:${notice.onceKey}` : notice.kind;
  return sendOnce(env, platformDb, notice.tenantId, key, () => noticeText(env, notice), notice.kind, fetcher, now);
}

/**
 * A notice about the platform itself, not one store (`tenant_id` `_platform`),
 * sent once per `key` on the same channel.
 */
export function notifyPlatform(
  env: Record<string, unknown> | null | undefined,
  platformDb: D1Database,
  key: string,
  text: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<"sent" | "duplicate" | "skipped" | "failed"> {
  return sendOnce(env, platformDb, "_platform", key, () => `[adsbook.id] ${text}`, key.split(":")[0], fetcher, now);
}

async function sendOnce(
  env: Record<string, unknown> | null | undefined,
  platformDb: D1Database,
  tenantId: string,
  key: string,
  text: () => string,
  kind: string,
  fetcher: typeof fetch,
  now: Date,
): Promise<"sent" | "duplicate" | "skipped" | "failed"> {
  const url = webhookUrl(env);
  if (!url) return "skipped";
  try {
    const claimed = await platformDb
      .prepare("INSERT INTO operator_notices (tenant_id, notice, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(tenantId, key, now.toISOString())
      .run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) return "duplicate";
    const body = text();
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body, content: body }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return "sent";
    console.error("operator-notice-failed", { kind, status: response.status });
    return "failed";
  } catch (error) {
    console.error("operator-notice-failed", { kind, error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}
