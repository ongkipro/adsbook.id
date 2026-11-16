import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../lib/api.ts";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import { tenantDatabase } from "../../../../lib/tenant-database.ts";
import {
  BILLING_CYCLES,
  billingConfigured,
  billingState,
  createInvoice,
  listBillingChannels,
  listInvoices,
  type BillingEnv,
  type InvoiceRow,
} from "../../../../platform/billing.ts";

export const prerender = false;

/** What the seller sees of an invoice: never the platform's settlement fields. */
export const invoiceView = (row: InvoiceRow) => ({
  id: row.id,
  number: row.invoice_number,
  cycle: row.cycle_code,
  days: row.days,
  amount: row.amount_idr,
  adminFee: row.admin_fee_idr,
  total: row.total_idr,
  channel: row.channel_code,
  qr: row.status === "pending" ? row.qr_payload : null,
  virtualAccount: row.status === "pending" ? row.virtual_account : null,
  paymentUrl: row.status === "pending" ? row.payment_url : null,
  status: row.status,
  expiresAt: row.expires_at,
  paidAt: row.paid_at,
  createdAt: row.created_at,
});

export async function billingContext(locals: App.Locals) {
  const env = (getRuntimeEnv(locals) ?? {}) as BillingEnv;
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  const tenantId = locals.tenantContext?.tenantId;
  if (!platformDb || !tenantId) return null;
  return { env, platformDb, tenantId };
}

export async function billingSummary(platformDb: D1Database, env: BillingEnv, tenantId: string) {
  const tenant = await platformDb
    .prepare("SELECT subscription_ends_at, grace_ends_at FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<{ subscription_ends_at: string | null; grace_ends_at: string | null }>();
  const subscriptionEndsAt = tenant?.subscription_ends_at ?? null;
  const graceEndsAt = tenant?.grace_ends_at ?? null;
  return {
    state: billingState({ subscriptionEndsAt, graceEndsAt }, new Date()),
    subscriptionEndsAt,
    graceEndsAt,
    configured: billingConfigured(env),
    cycles: Object.entries(BILLING_CYCLES).map(([code, cycle]) => ({ code, days: cycle.days, amount: cycle.amountIdr, label: cycle.label })),
    invoices: (await listInvoices(platformDb, tenantId)).map(invoiceView),
  };
}

/** UX-6: the store's subscription, the Option A cycles, live channels and invoices. */
export const GET: APIRoute = async ({ locals }) => {
  const ctx = await billingContext(locals);
  if (!ctx) return jsonError("Langganan belum tersedia.", 503);
  let channels: { code: string; name: string; fee: number; feeType: string }[] = [];
  let channelError: string | null = null;
  if (billingConfigured(ctx.env)) {
    try {
      channels = await listBillingChannels(ctx.env);
    } catch (error) {
      channelError = error instanceof Error ? error.message : "Metode pembayaran tidak tersedia.";
    }
  }
  return jsonOk({ data: { ...(await billingSummary(ctx.platformDb, ctx.env, ctx.tenantId)), channels, channelError } });
};

/** API-9: one QRIS/VA instruction for an Option A cycle (`{ cycle, channel }`). */
export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = await billingContext(locals);
  if (!ctx) return jsonError("Langganan belum tersedia.", 503);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const owner = await ctx.platformDb.prepare("SELECT owner_email FROM tenants WHERE id = ?").bind(ctx.tenantId).first<{ owner_email: string }>();
  const warehouse = await tenantDatabase(locals)
    ?.prepare("SELECT contact_phone FROM warehouses WHERE is_active = 1 AND contact_phone IS NOT NULL AND contact_phone <> '' ORDER BY is_primary DESC, id ASC LIMIT 1")
    .first<{ contact_phone: string }>()
    .catch(() => null);
  const created = await createInvoice(ctx.platformDb, ctx.env, {
    tenantId: ctx.tenantId,
    cycle: body?.cycle,
    channel: body?.channel,
    customer: {
      name: locals.tenant?.name || locals.tenantContext?.slug || "Toko",
      email: owner?.owner_email ?? "",
      phone: warehouse?.contact_phone ?? "",
    },
  });
  if (!created.ok) return jsonError(created.error, created.status);
  return jsonOk({ message: "Tagihan dibuat. Selesaikan pembayaran sebelum batas waktunya.", data: { invoice: invoiceView(created.value), ...(await billingSummary(ctx.platformDb, ctx.env, ctx.tenantId)) } });
};
