/**
 * The one set of words for an order's shipping status. The order list, the
 * order detail and the shipping queue each kept their own map, so the same
 * `processing` row read "Diproses", "Siap push Mengantar" (wrong: dispatch
 * sets `processing` only after Mengantar has accepted the shipment) and
 * "Antrean Mengantar" depending on the screen.
 */
export const SHIPPING_STATUS_LABELS: Record<string, string> = {
  pending: "Menunggu konfirmasi",
  processing: "Diproses Mengantar",
  // Mengantar's words (2026-11-28): ON DELIVERY, DELIVERED, RTS. The resi
  // check page already said these; the list, the order page and the shipping
  // queue said "Dikirim", "Selesai" and a bare "RTS".
  shipped: "Dalam pengiriman",
  delivered: "Terkirim",
  returned: "Retur (RTS)",
  cancelled: "Batal",
};

export const shippingStatusLabel = (status: string | null | undefined) =>
  (status && SHIPPING_STATUS_LABELS[status]) || status || "—";

export type FulfillmentStepState = "done" | "current" | "upcoming" | "stopped";
export type FulfillmentStep = { key: string; label: string; state: FulfillmentStepState; at: string | null };

const JOURNEY = [
  { key: "created", label: "Dibuat" },
  { key: "confirmed", label: "Dikonfirmasi" },
  { key: "processing", label: "Diproses" },
  { key: "shipped", label: "Dalam pengiriman" },
  { key: "delivered", label: "Terkirim" },
] as const;

/** How far each shipping status has come along JOURNEY (the index of its last finished step). */
const REACHED: Record<string, number> = { pending: 0, processing: 1, shipped: 2, delivered: 4 };

/**
 * The order's physical journey as one row of steps, for the order page:
 * Dibuat → Dikonfirmasi → Diproses → Dalam pengiriman → Terkirim. A returned or
 * cancelled order ends the row at the step it reached, with the outcome as
 * its last, "stopped" step. A digital order has no shipping journey (null).
 *
 * "Dikonfirmasi" is done whenever the order recorded `confirmed_at`: a CS
 * conversion confirms a lead and leaves it `pending` until dispatch. `at` is
 * only a time the order recorded for that very step (created, confirmed). The
 * courier's latest event is not placed on a step: nothing records which status
 * it set, and an operator can move the status by hand afterwards, so the order
 * page shows it beside the courier's own words instead.
 */
export function fulfillmentSteps(order: {
  shipping_status: string | null | undefined;
  fulfillment_type?: string | null;
  created_at: string | null;
  confirmed_at?: string | null;
}): FulfillmentStep[] | null {
  if (order.fulfillment_type === "digital") return null;
  const status = String(order.shipping_status || "pending");
  const outcome = status === "returned" || status === "cancelled" ? status : null;
  const confirmed = Boolean(order.confirmed_at);
  // Last finished step. A return happens after pickup; a cancel stops where the order stood.
  let reached = outcome === "returned" ? 2 : outcome === "cancelled" ? (confirmed ? 1 : 0) : (REACHED[status] ?? 0);
  if (confirmed) reached = Math.max(reached, 1);

  const steps: FulfillmentStep[] = JOURNEY.map((step, index) => ({
    ...step,
    state: index <= reached ? "done" : "upcoming",
    at: step.key === "created" ? order.created_at ?? null : step.key === "confirmed" ? order.confirmed_at ?? null : null,
  }));
  if (outcome) {
    steps.splice(reached + 1);
    steps.push({
      key: outcome,
      label: outcome === "returned" ? "Retur (RTS)" : "Dibatalkan",
      state: "stopped",
      at: null,
    });
    return steps;
  }
  // The step in progress: the one after the last finished, unless the journey is complete.
  if (reached < steps.length - 1) steps[reached + 1].state = "current";
  return steps;
}

/**
 * The order's landing path as a link on this store, or null. The path is
 * whatever the buyer's browser posted at checkout, so only a same-origin
 * relative path ("/promo-a?x=1") becomes a link: never a scheme
 * ("javascript:", "https:") or a protocol-relative "//other.host".
 */
export function storeRelativeHref(path: string | null | undefined): string | null {
  const value = String(path ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\s]/.test(value)) return null;
  return value;
}

export type MengantarStatusTone = "idle" | "moving" | "done" | "returned" | "attention";
export type MengantarStatusView = { category: string; label: string; tone: MengantarStatusTone };

/**
 * Mengantar's own status categories (Public API docs, webhook and Get orders,
 * read 2026-11-28) in the words a seller reads. The key is the category as
 * Mengantar sends it, upper-cased with single spaces; the courier values are
 * "the most frequent", not a closed list, so `mengantarStatusView` shows an
 * unknown one as received. "attention" marks what needs the seller to look:
 * a failed delivery or pickup, a courier cancel, a Mengantar error.
 */
export const MENGANTAR_STATUS_LABELS: Record<string, { label: string; tone: MengantarStatusTone }> = {
  "ACTIVE/WAITING NEXT PROCESS": { label: "Menunggu update kurir", tone: "idle" },
  ACTIVE: { label: "Menunggu update kurir", tone: "idle" },
  "PENDING PICKUP": { label: "Menunggu pickup", tone: "idle" },
  "PICKED UP": { label: "Sudah dipickup", tone: "moving" },
  "ON DELIVERY": { label: "Dalam pengiriman", tone: "moving" },
  DELIVERED: { label: "Terkirim", tone: "done" },
  UNDELIVERED: { label: "Gagal kirim", tone: "attention" },
  "PICKUP FAILED": { label: "Gagal pickup", tone: "attention" },
  RTS: { label: "Retur (RTS)", tone: "returned" },
  CANCELED: { label: "Dibatalkan kurir", tone: "attention" },
  CANCELLED: { label: "Dibatalkan kurir", tone: "attention" },
  ERROR: { label: "Error Mengantar", tone: "attention" },
};

/** Mengantar's category, normalised the way the webhook mapper compares it: trimmed, single-spaced, upper case. */
export function normalizeMengantarCategory(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return value || null;
}

/** How a stored Mengantar category reads on the shipping page; null when the order has none yet. */
export function mengantarStatusView(raw: string | null | undefined): MengantarStatusView | null {
  const category = normalizeMengantarCategory(raw);
  if (!category) return null;
  const known = MENGANTAR_STATUS_LABELS[category];
  return known ? { category, ...known } : { category, label: category, tone: "idle" };
}

/**
 * What the shipping page's Mengantar block shows for one shipment, decided here
 * so it can be tested (the component only renders it).
 *
 * - `headline`: Mengantar's category in a seller's words; when no category is
 *   stored yet but a courier line is (an order synced before categories were
 *   kept, or a legacy flag response), that line is the headline, never
 *   "Belum ada update dari kurir" beside an actual update.
 * - `showLabel`: the coloured label is left out when it only repeats the
 *   order's own badge ("Dalam pengiriman" twice); a state needing a look always
 *   shows.
 * - `reference`: "Mengantar: <CATEGORY>" only when it says more than the label
 *   (an unknown category already reads as received).
 * - `courierLine`: the stored text, hidden only when it is exactly what the
 *   webhook writes for that category, so a courier line that happens to
 *   contain the word ("DELIVERED TO BUDI") stays visible.
 */
export function mengantarBlock(input: {
  category: string | null | undefined;
  text: string | null | undefined;
  orderStatusLabel: string;
}): {
  view: MengantarStatusView | null;
  headline: string;
  showLabel: boolean;
  reference: string | null;
  courierLine: string | null;
} {
  const view = mengantarStatusView(input.category);
  const text = input.text?.trim() || null;
  if (!view) {
    return { view: null, headline: text ?? "Belum ada update dari kurir", showLabel: false, reference: null, courierLine: null };
  }
  const webhookText = new Set([
    view.category,
    view.label,
    `Perlu perhatian kurir (${view.category})`,
    `Pembatalan dari kurir — perlu cek operator (${view.category})`,
    "Status Mengantar ERROR — perlu cek",
  ].map((value) => value.toUpperCase()));
  return {
    view,
    headline: view.label,
    showLabel: view.tone === "attention" || view.label !== input.orderStatusLabel,
    reference: view.label === view.category ? null : view.category,
    courierLine: text && !webhookText.has(text.toUpperCase()) ? text : null,
  };
}
