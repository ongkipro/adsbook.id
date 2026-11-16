/**
 * Store readiness (T-38, PR-23, UX-2, UX-5): the one predicate that decides
 * whether buyers may use a tenant's storefront, computed from the tenant's
 * own data on every request — never from stored clicks.
 *
 * Ready = store name set; at least one active product with a variant that
 * has a price and a weight; at least one enabled payment method (COD, or
 * AutoLaris with everything its order rail validates); a Mengantar API key;
 * and the **primary** warehouse active with origin area and pickup address
 * (`isWarehouseReady`). A secondary warehouse never stands in for it: checkout
 * falls back to the primary whatever its readiness.
 *
 * At least one courier must be on (no courier, no quote). Optional steps
 * (custom domain, ad signals) never affect it.
 */
import { autoLarisOrderRailGap } from "../lib/provider-config.ts";

export type ReadinessFacts = {
  storeName: boolean;
  product: boolean;
  primaryWarehouse: boolean;
  mengantar: boolean;
  payment: boolean;
  enabledCouriers: number;
  signals: boolean;
};

type Row = {
  store_name: number | null;
  product: number;
  primary_warehouse: number;
  mengantar_api_key: string | null;
  cod: number | null;
  autolaris_on: number | null;
  autolaris_key: string | null;
  autolaris_origin: string | null;
  autolaris_destination: string | null;
  warehouse_address: string | null;
  couriers: number;
  signals: number;
};

/** One read of the tenant store. Throws when the store cannot be read: the caller fails closed. */
export async function readReadiness(database: D1Database): Promise<ReadinessFacts> {
  const row = await database
    .prepare(
      `SELECT
         (SELECT TRIM(COALESCE(name, '')) <> '' FROM stores ORDER BY id LIMIT 1) AS store_name,
         EXISTS (SELECT 1 FROM products p JOIN product_variants v ON v.product_id = p.id
                 WHERE p.is_active = 1 AND v.price > 0 AND v.weight_grams > 0) AS product,
         EXISTS (SELECT 1 FROM warehouses WHERE is_primary = 1 AND is_active = 1
                 AND TRIM(COALESCE(origin_area_id, '')) <> '' AND TRIM(COALESCE(pickup_address_id, '')) <> '') AS primary_warehouse,
         s.mengantar_api_key, s.is_cod_enabled AS cod, s.is_autolaris_enabled AS autolaris_on,
         s.autolaris_api_key AS autolaris_key, s.autolaris_order_origin_id AS autolaris_origin,
         s.autolaris_order_destination_id AS autolaris_destination,
         (SELECT address FROM warehouses ORDER BY id LIMIT 1) AS warehouse_address,
         (SELECT COUNT(*) FROM courier_rules WHERE is_enabled = 1) AS couriers,
         (TRIM(COALESCE(s.meta_pixel_id, '')) <> '' OR TRIM(COALESCE(s.google_ads_conversion_id, '')) <> '') AS signals
       FROM (SELECT 1) LEFT JOIN (SELECT * FROM stores ORDER BY id LIMIT 1) s`,
    )
    .first<Row>();
  if (!row) throw new Error("readiness unreadable");
  const text = (value: string | null) => (value ?? "").trim();
  // The same inputs /api/payment-methods offers AutoLaris on, so "enabled"
  // here means exactly what a buyer would be offered.
  const autolaris =
    row.autolaris_on !== 0 &&
    autoLarisOrderRailGap({
      apiKey: text(row.autolaris_key),
      originId: text(row.autolaris_origin),
      destinationId: text(row.autolaris_destination),
      warehouseAddress: row.warehouse_address,
    }) === null;
  return {
    storeName: Boolean(row.store_name),
    product: Boolean(row.product),
    primaryWarehouse: Boolean(row.primary_warehouse),
    mengantar: text(row.mengantar_api_key) !== "",
    // A store row with COD left on (the default) offers COD.
    payment: (row.store_name !== null && row.cod !== 0) || autolaris,
    enabledCouriers: Number(row.couriers) || 0,
    signals: Boolean(row.signals),
  };
}

export function isStoreReady(facts: ReadinessFacts): boolean {
  // `enabledCouriers` is PR-23's "a shipping quote is possible": with every
  // courier switched off no buyer can be quoted, so the store is not ready.
  return facts.storeName && facts.product && facts.primaryWarehouse && facts.mengantar && facts.enabledCouriers > 0 && facts.payment;
}

/**
 * Paths an unready store still answers: the owner's way in and the machines
 * that configure or call back. Everything else — every buyer page and API,
 * checkout included — answers "toko belum siap" (default deny).
 */
export function servedBeforeReady(pathname: string, method: string): boolean {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  const read = method === "GET" || method === "HEAD";
  return (
    under("/admin") ||
    under("/api/admin") ||
    under("/api/webhooks") ||
    // Read-only by method, not by today's operation list: a write added later stays gated.
    (read && under("/api/ops")) ||
    under("/assets") ||
    under("/media") ||
    pathname === "/hello" ||
    pathname === "/api/handoff" ||
    // The Mengantar area lookup the warehouse step itself needs
    // (WarehouseOriginPicker): read-only, never an order.
    (read && pathname === "/api/locations") ||
    pathname === "/pemulihan" ||
    pathname === "/api/owner-recovery"
  );
}
