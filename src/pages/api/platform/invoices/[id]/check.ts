import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { checkInvoice, loadInvoice, type BillingEnv } from "../../../../../platform/billing.ts";

export const prerender = false;

const MESSAGES: Record<string, string> = {
  credited: "Lunas — hari langganan ditambahkan.",
  "already-paid": "Sudah lunas.",
  pending: "Belum dibayar.",
  unproven: "Status belum pasti; dicek lagi oleh cron.",
  "no-transaction": "Tagihan tanpa transaksi AutoLaris.",
  unavailable: "AutoLaris platform belum tersedia.",
};

/**
 * UX-8 (T-52): an operator asks AutoLaris Advice about one subscription
 * invoice. Same path as the cron (checkInvoice → settleInvoice), so a paid
 * invoice credits its days at most once. Owner or support; session required.
 */
export const POST: APIRoute = async ({ locals, params }) => {
  const env = (getRuntimeEnv(locals) ?? {}) as BillingEnv;
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  if (!platformDb || !locals.platformUser) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const id = String(params.id ?? "");
  const owner = /^inv_[0-9a-f]{32}$/.test(id)
    ? await platformDb.prepare("SELECT tenant_id FROM subscription_invoices WHERE id = ?").bind(id).first<{ tenant_id: string }>()
    : null;
  const invoice = owner ? await loadInvoice(platformDb, owner.tenant_id, id) : null;
  if (!invoice) return Response.json({ success: false, error: "Tagihan tidak ditemukan." }, { status: 404 });
  try {
    const outcome = await checkInvoice(platformDb, env, invoice);
    return Response.json({ success: true, message: MESSAGES[outcome] ?? outcome, data: { outcome } }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    console.error("platform-invoice-check-failed", { invoice: invoice.invoice_number, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return Response.json({ success: false, error: "AutoLaris tidak menjawab. Coba lagi." }, { status: 502 });
  }
};
