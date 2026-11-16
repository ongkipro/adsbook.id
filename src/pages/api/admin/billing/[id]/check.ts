import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../../lib/api.ts";
import { checkInvoice, loadInvoice } from "../../../../../platform/billing.ts";
import { billingContext, billingSummary } from "../index.ts";

export const prerender = false;

/**
 * API-9 "Cek Status Pembayaran": ask AutoLaris (Advice) about one of this
 * store's invoices. Only an explicit settlement credits the days (ADR-022).
 */
export const POST: APIRoute = async ({ params, locals }) => {
  const ctx = await billingContext(locals);
  if (!ctx) return jsonError("Langganan belum tersedia.", 503);
  const invoice = await loadInvoice(ctx.platformDb, ctx.tenantId, String(params.id ?? ""));
  if (!invoice) return jsonError("Tagihan tidak ditemukan.", 404);
  let outcome: string;
  try {
    outcome = await checkInvoice(ctx.platformDb, ctx.env, invoice);
  } catch (error) {
    console.error("platform-billing-check-failed", { invoice: invoice.invoice_number, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    return jsonError("Status pembayaran belum bisa dicek. Coba lagi sebentar lagi.", 502);
  }
  const message =
    outcome === "credited" || outcome === "already-paid"
      ? "Pembayaran diterima. Langganan toko aktif."
      : outcome === "pending"
        ? "Pembayaran belum masuk. Kalau sudah membayar, cek lagi dalam beberapa menit."
        : "Status pembayaran belum bisa dipastikan. Kami cek otomatis setiap jam; hubungi admin adsbook.id bila sudah membayar.";
  return jsonOk({ message, data: { outcome, ...(await billingSummary(ctx.platformDb, ctx.env, ctx.tenantId)) } });
};
