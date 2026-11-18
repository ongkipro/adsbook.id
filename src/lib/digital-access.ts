/**
 * The paid buyer's access to a digital product (DIGITAL-PRODUCTS-SPEC §5.2, §8.1).
 *
 * The access link and note live on the product (`products.digital_access_url`,
 * `digital_access_note`) and are read here, at the moment a buyer holding the
 * order's `(id, status_token)` pair asks, and only when the order is digital,
 * paid, and not void. A refund or cancellation closes it again on the next
 * request: nothing is copied onto the order, so there is nothing to revoke.
 * `digital-access-guard.test.ts` keeps every other reader out.
 */
import { isVoidOrder } from "./order-lifecycle.ts";
import { parseDigitalAccessUrl } from "./product-mutation.ts";

const PAID = new Set(["paid", "settled", "success"]);

export type DigitalAccess = {
  url: string;
  note: string | null;
  product_name: string;
  accessed_at: string | null;
};

type AccessRow = {
  id: number;
  fulfillment_type: string | null;
  payment_status: string | null;
  shipping_status: string | null;
  stock_restored_at: string | null;
  digital_accessed_at: string | null;
  title: string | null;
  digital_access_url: string | null;
  digital_access_note: string | null;
};

/** Whether this order's buyer may open its digital product now. */
export function digitalAccessOpen(order: {
  fulfillment_type?: string | null;
  payment_status?: string | null;
  shipping_status?: string | null;
  stock_restored_at?: string | null;
}): boolean {
  if (order.fulfillment_type !== "digital") return false;
  const payment = String(order.payment_status ?? "").toLowerCase();
  if (!PAID.has(payment)) return false;
  return !isVoidOrder({ payment_status: payment, shipping_status: String(order.shipping_status ?? ""), stock_restored_at: order.stock_restored_at ?? null });
}

const ORDER_MATCH = "(CAST(o.id AS TEXT) = ? OR o.order_number = ?) AND o.public_status_token = ?";

/**
 * The order's fulfillment type, and its access when it is open. `null` for an
 * unknown order or a wrong token — the caller answers that as it answers any
 * order it cannot find.
 */
export async function readDigitalAccess(
  database: D1Database,
  orderIdentity: string,
  statusToken: string,
): Promise<{ fulfillmentType: "digital" | "physical"; access: DigitalAccess | null } | null> {
  if (!orderIdentity || !statusToken) return null;
  const row = await database
    .prepare(
      `SELECT o.id, o.fulfillment_type, o.payment_status, o.shipping_status, o.stock_restored_at, o.digital_accessed_at,
              p.title, p.digital_access_url, p.digital_access_note
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN product_variants v ON v.id = oi.variant_id
         LEFT JOIN products p ON p.id = v.product_id AND p.product_type = 'digital'
        WHERE ${ORDER_MATCH}
        ORDER BY (p.id IS NULL), oi.id
        LIMIT 1`,
    )
    .bind(orderIdentity, orderIdentity, statusToken)
    .first<AccessRow>();
  if (!row) return null;
  const fulfillmentType = row.fulfillment_type === "digital" ? "digital" : "physical";
  if (!digitalAccessOpen(row)) return { fulfillmentType, access: null };
  // Checked again on the way out: a link that is not https never reaches a buyer's page.
  const url = parseDigitalAccessUrl(row.digital_access_url);
  if (!url) return { fulfillmentType, access: null };
  return {
    fulfillmentType,
    access: {
      url,
      note: row.digital_access_note?.trim() || null,
      product_name: row.title ?? "",
      accessed_at: row.digital_accessed_at,
    },
  };
}

/**
 * Stamps the buyer's first open (§5.2: the seller's proof the product was
 * received). Only for an open order; the first stamp is kept. True when the
 * order is open (stamped now or before).
 */
export async function markDigitalAccessed(
  database: D1Database,
  orderIdentity: string,
  statusToken: string,
  now = new Date(),
): Promise<boolean> {
  const current = await readDigitalAccess(database, orderIdentity, statusToken);
  if (!current?.access) return false;
  await database
    .prepare(
      `UPDATE orders AS o
          SET digital_accessed_at = COALESCE(o.digital_accessed_at, ?)
        WHERE ${ORDER_MATCH}
          AND o.fulfillment_type = 'digital'
          AND o.payment_status IN ('paid', 'settled', 'success')
          AND o.stock_restored_at IS NULL
          AND o.shipping_status NOT IN ('cancelled', 'returned')`,
    )
    .bind(now.toISOString(), orderIdentity, orderIdentity, statusToken)
    .run();
  return true;
}
