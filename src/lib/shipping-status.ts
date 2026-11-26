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
  shipped: "Dikirim",
  delivered: "Selesai",
  returned: "RTS",
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
  { key: "shipped", label: "Dikirim" },
  { key: "delivered", label: "Selesai" },
] as const;

/** How far each shipping status has come along JOURNEY (the index of its last finished step). */
const REACHED: Record<string, number> = { pending: 0, processing: 1, shipped: 2, delivered: 4 };

/**
 * The order's physical journey as one row of steps, for the order page:
 * Dibuat → Dikonfirmasi → Diproses → Dikirim → Selesai. A returned or
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
