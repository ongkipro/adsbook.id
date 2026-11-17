/**
 * A checkout refusal that means "this store is not taking orders" — a store in
 * Preview Mode or past its grace (402 `SUBSCRIPTION_*`, ADR-041) or the demo
 * store (403 `DEMO_STORE`, PR-26) — as opposed to a field the buyer can fix.
 * The order forms stop retrying on it and show the buyer one plain sentence;
 * they used to retry and then say the shipping cost could not be calculated.
 */
export const STORE_CLOSED_CODES: ReadonlySet<string> = new Set(["SUBSCRIPTION_REQUIRED", "SUBSCRIPTION_EXPIRED", "DEMO_STORE"]);

const FALLBACK = "Toko ini belum menerima pesanan. Silakan hubungi penjual atau coba lagi nanti.";
const DEMO = "Ini toko contoh adsbook.id: pemesanan tidak aktif.";

export function isStoreClosed(payload: unknown): boolean {
  const code = (payload as { code?: unknown } | null)?.code;
  return typeof code === "string" && STORE_CLOSED_CODES.has(code);
}

export function storeClosedMessage(payload: unknown): string {
  const body = payload as { code?: unknown; buyer_message?: unknown } | null;
  if (body?.code === "DEMO_STORE") return DEMO;
  return typeof body?.buyer_message === "string" && body.buyer_message.trim() ? body.buyer_message.trim() : FALLBACK;
}

export class StoreClosedError extends Error {}
