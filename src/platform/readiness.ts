/**
 * Store readiness (T-38, PR-23, UX-2, UX-5): the one predicate that decides
 * whether buyers may use a tenant's storefront, computed from the tenant's
 * own data on every request — never from stored clicks.
 *
 * Ready = store name set; at least one active product with a variant that
 * has a price and a weight; a way for every buyer to pay
 * (ONBOARDING-BANK-WAREHOUSE-SPEC §2: an active bank account or AutoLaris with
 * everything its order rail validates — COD alone only when it is on and
 * excludes no province, since the default excludes 15); a Mengantar API key;
 * and the **primary** warehouse active with origin area and pickup address
 * (`isWarehouseReady`). A secondary warehouse never stands in for it: checkout
 * falls back to the primary whatever its readiness.
 *
 * At least one courier must be on (no courier, no quote). Optional steps
 * (custom domain, ad signals) never affect it.
 *
 * Digital products (DIGITAL-PRODUCTS-SPEC §3): the **digital track** is ready
 * with the store's name, one active digital product (a priced variant and an
 * `https://` access link) and one prepaid rail (AutoLaris as above, or an
 * active bank account for manual transfer) — no warehouse, Mengantar key or
 * courier, since nothing it sells ships. A `digital` store needs that track, a
 * `physical` store the physical one, and a `hybrid` store **either**: adding a
 * physical product before the warehouse is set up never closes a store that is
 * already selling digital (review finding 1). The physical products of such a
 * store are refused at the order boundary until it can ship them
 * (`physicalShippingReady`, `persistOrder`).
 *
 * The one demo store (PR-26) is the only exception: the middleware lets it
 * browse without this predicate and refuses its provider routes and writes
 * instead (`src/platform/demo.ts`).
 */
import { openCredential } from "../lib/credential-crypto.ts";
import { autoLarisOrderRailGap } from "../lib/provider-config.ts";
import { AUTOLARIS_CHANNEL_OPTIONS, resolveDisabledAutoLarisChannels } from "../lib/autolaris-client.ts";
import { getCodDisabledProvinceCodes } from "../lib/form-mode.ts";

export type CatalogMode = "physical" | "digital" | "hybrid";

export function normalizeCatalogMode(value: unknown): CatalogMode {
  return value === "digital" || value === "hybrid" ? value : "physical";
}

export type ReadinessFacts = {
  catalogMode: CatalogMode;
  /** At least one active physical product, priced or not: a hybrid store that has one is held to the physical predicate. */
  physicalCatalog: boolean;
  /** An active digital product with a priced variant and an https access link. */
  digitalProduct: boolean;
  /** A rail that is paid before access: AutoLaris, or an active bank account for manual transfer. */
  prepaid: boolean;
  storeName: boolean;
  product: boolean;
  primaryWarehouse: boolean;
  mengantar: boolean;
  /**
   * ONBOARDING-BANK-WAREHOUSE-SPEC §2: every buyer of a physical store can pay.
   * A prepaid rail (bank account or AutoLaris), or COD open to every province;
   * COD alone does not do when a province is excluded from it (15 by default).
   */
  payment: boolean;
  /** Provinces excluded from COD (the store's list, or the default 15); 0 = COD everywhere. */
  codDisabledProvinces: number;
  enabledCouriers: number;
  signals: boolean;
};

type Row = {
  catalog_mode: string | null;
  physical_catalog: number;
  digital_product: number;
  bank_account: number;
  store_name: number | null;
  product: number;
  primary_warehouse: number;
  mengantar_api_key: string | null;
  cod: number | null;
  cod_disabled_province_codes: string | null;
  autolaris_on: number | null;
  disabled_autolaris_channels: string | null;
  autolaris_key: string | null;
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
                 WHERE p.is_active = 1 AND p.product_type = 'physical' AND v.price > 0 AND v.weight_grams > 0) AS product,
         EXISTS (SELECT 1 FROM products WHERE is_active = 1 AND product_type = 'physical') AS physical_catalog,
         EXISTS (SELECT 1 FROM products p JOIN product_variants v ON v.product_id = p.id
                 WHERE p.is_active = 1 AND p.product_type = 'digital' AND v.price > 0
                 AND p.digital_access_url LIKE 'https://_%') AS digital_product,
         EXISTS (SELECT 1 FROM seller_bank_accounts WHERE is_active = 1) AS bank_account,
         s.catalog_mode,
         EXISTS (SELECT 1 FROM warehouses WHERE is_primary = 1 AND is_active = 1
                 AND TRIM(COALESCE(origin_area_id, '')) <> '' AND TRIM(COALESCE(pickup_address_id, '')) <> '') AS primary_warehouse,
         s.mengantar_api_key, s.is_cod_enabled AS cod, s.cod_disabled_province_codes, s.is_autolaris_enabled AS autolaris_on, s.disabled_autolaris_channels,
         s.autolaris_api_key AS autolaris_key,
         (SELECT COUNT(*) FROM courier_rules WHERE is_enabled = 1) AS couriers,
         (TRIM(COALESCE(s.meta_pixel_id, '')) <> '' OR TRIM(COALESCE(s.google_ads_conversion_id, '')) <> '') AS signals
       FROM (SELECT 1) LEFT JOIN (SELECT * FROM stores ORDER BY id LIMIT 1) s`,
    )
    .first<Row>();
  if (!row) throw new Error("readiness unreadable");
  const text = (value: string | null) => (value ?? "").trim();
  // ADR-040: a key counts only if this Worker can open it; one it cannot is a
  // key the provider calls would not get, so the store is not ready.
  const [mengantarKey, autolarisKey] = await Promise.all([
    openCredential(database, "mengantar_api_key", row.mengantar_api_key),
    openCredential(database, "autolaris_api_key", row.autolaris_key),
  ]);
  // The same inputs /api/payment-methods offers AutoLaris on, so "enabled"
  // here means exactly what a buyer would be offered.
  // ...and with at least one channel the store left on: every channel off offers the buyer nothing.
  const disabledChannels: readonly string[] = resolveDisabledAutoLarisChannels(row.disabled_autolaris_channels);
  const autolaris =
    row.autolaris_on !== 0 &&
    autoLarisOrderRailGap({ apiKey: text(autolarisKey) }) === null &&
    AUTOLARIS_CHANNEL_OPTIONS.some((channel) => !disabledChannels.includes(channel.code));
  const prepaid = autolaris || Boolean(row.bank_account);
  const codOn = row.store_name !== null && row.cod !== 0;
  const codDisabledProvinces = getCodDisabledProvinceCodes(row.cod_disabled_province_codes).length;
  return {
    catalogMode: normalizeCatalogMode(row.catalog_mode),
    physicalCatalog: Boolean(row.physical_catalog),
    digitalProduct: Boolean(row.digital_product),
    prepaid,
    storeName: Boolean(row.store_name),
    product: Boolean(row.product),
    primaryWarehouse: Boolean(row.primary_warehouse),
    mengantar: text(mengantarKey) !== "",
    // A buyer outside COD's provinces (or every buyer, with COD off) pays by transfer or AutoLaris.
    payment: prepaid || (codOn && codDisabledProvinces === 0),
    codDisabledProvinces,
    enabledCouriers: Number(row.couriers) || 0,
    signals: Boolean(row.signals),
  };
}

/** What a physical order needs to ship: the primary warehouse, a Mengantar key and a courier. */
export function physicalShippingReady(facts: Pick<ReadinessFacts, "primaryWarehouse" | "mengantar" | "enabledCouriers">): boolean {
  // `enabledCouriers` is PR-23's "a shipping quote is possible": with every
  // courier switched off no buyer can be quoted.
  return facts.primaryWarehouse && facts.mengantar && facts.enabledCouriers > 0;
}

function physicalReady(facts: ReadinessFacts): boolean {
  return facts.storeName && facts.product && physicalShippingReady(facts) && facts.payment;
}

function digitalReady(facts: ReadinessFacts): boolean {
  return facts.storeName && facts.digitalProduct && facts.prepaid;
}

/**
 * The steps the setup checklist owes (UX-2 = PR-23): a digital store the
 * digital ones; a hybrid store the digital ones once that track is ready or
 * while it has no physical product, the physical ones otherwise. The required
 * steps are then all done exactly when `isStoreReady` holds.
 */
export function readinessTrack(facts: ReadinessFacts): "physical" | "digital" {
  if (facts.catalogMode === "digital") return "digital";
  if (facts.catalogMode === "physical") return "physical";
  return digitalReady(facts) || !facts.physicalCatalog ? "digital" : "physical";
}

export function isStoreReady(facts: ReadinessFacts): boolean {
  if (facts.catalogMode === "digital") return digitalReady(facts);
  if (facts.catalogMode === "physical") return physicalReady(facts);
  return digitalReady(facts) || physicalReady(facts);
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
