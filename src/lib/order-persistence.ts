import {
  calculateCodCustomerTotal,
  calculateCodFeeBreakdown,
  normalizePaymentFeeBearer,
  type PaymentFeeBearer,
} from "./payment-fee-policy.ts";
import { paymentBrandLabel } from "./payment-brand.ts";
import { physicalShippingReady, readReadiness } from "../platform/readiness.ts";
import { buildOrderNotification, recordNotification } from "./notifications.ts";
import { isValidWa62, normalizePhone } from "./validation.ts";

export type PersistOrderInput = {
  submitToken: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  address: string;
  province: string;
  city: string;
  district: string;
  postalCode?: string;
  variantKey: string;
  quantity: number;
  shippingCost: number;
  paymentMethod: "cod" | "bank_transfer" | "qris" | "manual_transfer";
  sellerBankAccountId?: number;
  warehouseId?: number;
  destinationAreaId?: string;
  courierCode?: string;
  courierService?: string;
  adClickIds?: string;
  metaRequestContext?: string;
  sourcePagePath?: string;
};

export type PersistedOrder = {
  id: number;
  orderNumber: string;
  publicStatusToken: string;
  totalAmount: number;
  unitPrice: number;
  codServiceFee: number;
  codServiceFeeVat: number;
  codFeeBearer: PaymentFeeBearer;
  sellerBankAccountId?: number;
  sellerBankCode?: string;
  sellerBankName?: string;
  sellerAccountHolder?: string;
  sellerAccountNumber?: string;
  created: boolean;
};

export class DuplicateSubmissionError extends Error {}
export class OrderInputError extends Error {}

export const CHECKOUT_DEDUPE_WINDOW_MS = 2 * 60 * 60 * 1000;

type CanonicalOrderRow = {
  id: number;
  order_number: string;
  public_status_token: string;
  total_amount: number;
  unit_price: number;
  cod_service_fee: number;
  cod_service_fee_vat: number;
  cod_fee_bearer: string;
  seller_bank_account_id: number | null;
  seller_bank_code: string | null;
  seller_bank_name: string | null;
  seller_account_holder: string | null;
  seller_account_number: string | null;
};

function normalizeFingerprintText(value: string | undefined) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function createCheckoutFingerprint(input: {
  storeId: number;
  variantId: number;
  order: PersistOrderInput;
  totalAmount: number;
}) {
  const order = input.order;
  const payload = JSON.stringify([
    input.storeId,
    input.variantId,
    order.quantity,
    normalizeFingerprintText(order.customerName),
    normalizePhone(order.customerPhone),
    normalizeFingerprintText(order.address),
    normalizeFingerprintText(order.province),
    normalizeFingerprintText(order.city),
    normalizeFingerprintText(order.district),
    normalizeFingerprintText(order.postalCode),
    order.paymentMethod,
    order.sellerBankAccountId || 0,
    order.warehouseId || 0,
    normalizeFingerprintText(order.destinationAreaId),
    normalizeFingerprintText(order.courierCode),
    normalizeFingerprintText(order.courierService),
    order.shippingCost,
    input.totalAmount,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function persistedOrderFromRow(
  row: CanonicalOrderRow,
  created: boolean,
): PersistedOrder {
  return {
    id: row.id,
    orderNumber: row.order_number,
    publicStatusToken: row.public_status_token,
    totalAmount: Number(row.total_amount),
    unitPrice: Number(row.unit_price),
    codServiceFee: Number(row.cod_service_fee),
    codServiceFeeVat: Number(row.cod_service_fee_vat),
    codFeeBearer: normalizePaymentFeeBearer(row.cod_fee_bearer),
    sellerBankAccountId: row.seller_bank_account_id || undefined,
    sellerBankCode: row.seller_bank_code || undefined,
    sellerBankName: row.seller_bank_name || undefined,
    sellerAccountHolder: row.seller_account_holder || undefined,
    sellerAccountNumber: row.seller_account_number || undefined,
    created,
  };
}

async function findCanonicalOrder(
  database: D1Database,
  fingerprint: string,
  submitToken: string,
  now: string,
) {
  return database
    .prepare(
      `SELECT o.id, o.order_number, o.public_status_token, o.total_amount,
              oi.unit_price, o.cod_service_fee, o.cod_service_fee_vat,
              o.cod_fee_bearer, o.seller_bank_account_id, o.seller_bank_code,
              o.seller_bank_name, o.seller_account_holder, o.seller_account_number
       FROM orders o
       INNER JOIN order_items oi ON oi.order_id = o.id
       WHERE (
           (o.checkout_fingerprint = ? AND o.checkout_dedupe_expires_at > ?)
           OR o.submit_token = ?
         )
         AND o.shipping_status IN ('pending', 'processing', 'shipped')
         AND o.payment_status NOT IN ('failed', 'refunded', 'cancelled')
       ORDER BY o.id DESC, oi.id ASC
       LIMIT 1`,
    )
    .bind(fingerprint, now, submitToken)
    .first<CanonicalOrderRow>();
}

export type OrderNumberPrefix = "INV" | "ABN";

/**
 * Advances the one store-wide order sequence in a single D1 statement.
 *
 * Completed and abandoned orders deliberately share a sequence. An abandoned
 * number can therefore be promoted by changing only its prefix without ever
 * colliding with a completed order allocated in the meantime.
 */
export async function allocateOrderNumber(
  database: D1Database,
  prefix: OrderNumberPrefix,
): Promise<string> {
  const row = await database
    .prepare(
      `UPDATE order_number_counters
       SET last_value = last_value + 1,
           updated_at = ?
       WHERE counter_name = 'orders'
       RETURNING last_value`,
    )
    .bind(new Date().toISOString())
    .first<{ last_value: number }>();
  const value = Number(row?.last_value);
  if (!Number.isInteger(value) || value <= 10000) {
    throw new Error("Nomor order gagal dialokasikan.");
  }
  return `${prefix}-${value}`;
}

function completedNumberFromAbandoned(orderNumber: string): string {
  if (!/^ABN-\d{5,}$/.test(orderNumber)) {
    throw new Error("Nomor pesanan tertinggal tidak valid.");
  }
  return `INV-${orderNumber.slice(4)}`;
}

/**
 * A lead is kept 14 days from capture, then deleted with its items and payment
 * rows (owner 2026-11-10, ADR-035; was 7). The hourly cron and
 * `POST /api/admin/orders/retention` are the only paths that delete a lead:
 * the order delete route refuses one, so a lead is never removed early by hand.
 */
export const ABANDONED_RETENTION_DAYS = 14;

export async function purgeExpiredAbandonedOrders(
  database: D1Database,
  now = new Date(),
): Promise<number> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Waktu retensi tidak valid.");
  }
  const cutoff = now.toISOString();
  const eligibleOrderIds = `SELECT id
    FROM orders
    WHERE shipping_status = 'abandoned'
      AND payment_status = 'unpaid'
      AND unixepoch(created_at) < unixepoch(?, '-${ABANDONED_RETENTION_DAYS} days')`;
  const results = await database.batch([
    database
      .prepare(
        `DELETE FROM payment_transactions
         WHERE order_id IN (${eligibleOrderIds})`,
      )
      .bind(cutoff),
    database
      .prepare(
        `DELETE FROM order_items
         WHERE order_id IN (${eligibleOrderIds})`,
      )
      .bind(cutoff),
    database
      .prepare(
        `DELETE FROM orders
         WHERE id IN (${eligibleOrderIds})`,
      )
      .bind(cutoff),
  ]);
  return Number(results[2]?.meta?.changes ?? 0);
}

export type RecordAbandonedOrderInput = {
  customerName: string;
  customerPhone: string;
  address?: string;
  province?: string;
  totalAmount?: number;
  variantId?: number;
  /** The page the lead was captured on (PRD A36), already clipped. */
  sourcePagePath?: string | null;
  /**
   * The buyer's Meta identity and ad click ids at capture (audit F-5). A lead
   * CS later converts becomes a Purchase sent from an admin request, which
   * carries the operator's browser, not the buyer's.
   */
  metaRequestContext?: string;
  adClickIds?: string;
};

export type RecordedAbandonedOrder = {
  id: number;
  orderNumber: string;
  customerPhone: string;
  action: "created" | "updated";
};

export async function recordAbandonedOrder(
  database: D1Database,
  input: RecordAbandonedOrderInput,
): Promise<RecordedAbandonedOrder> {
  const customerName = input.customerName.trim();
  const customerPhone = normalizePhone(input.customerPhone);
  if (customerName.length < 3) {
    throw new OrderInputError("Nama pelanggan minimal 3 karakter.");
  }
  if (!isValidWa62(customerPhone)) {
    throw new OrderInputError("Nomor WhatsApp tidak valid.");
  }
  const address = input.address?.trim() || "";
  const province = input.province?.trim() || "";
  const selectedVariant = input.variantId && input.variantId > 0
    ? await database
        .prepare(
          `SELECT pv.id, pv.price
           FROM product_variants pv
           INNER JOIN products p ON p.id = pv.product_id
           WHERE pv.id = ? AND p.is_active = 1
           LIMIT 1`,
        )
        .bind(input.variantId)
        .first<{ id: number; price: number }>()
    : null;
  const totalAmount = selectedVariant
    ? Math.max(0, Math.round(Number(selectedVariant.price) || 0))
    : 0;
  const createdAt = new Date().toISOString();
  const existing = await database
    .prepare(
      `SELECT id, order_number
       FROM orders
       WHERE customer_phone = ?
         AND shipping_status = 'abandoned'
         AND unixepoch(created_at) >= unixepoch('now', '-2 hours')
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(customerPhone)
    .first<{ id: number; order_number: string }>();

  if (existing) {
    const statements = [database
      .prepare(
        `UPDATE orders
         SET customer_name = ?,
             address = COALESCE(NULLIF(?, ''), address),
             province = COALESCE(NULLIF(?, ''), province),
             total_amount = ?,
             payment_status = 'unpaid',
             shipping_status = 'abandoned',
             created_at = ?,
             source_page_path = COALESCE(source_page_path, ?),
             meta_request_context = COALESCE(?, meta_request_context),
             ad_click_ids = COALESCE(?, ad_click_ids)
         WHERE id = ? AND shipping_status = 'abandoned'`,
      )
      .bind(
        customerName,
        address,
        province,
        totalAmount,
        createdAt,
        input.sourcePagePath || null,
        input.metaRequestContext || null,
        input.adClickIds || null,
        existing.id,
      )
    ];
    if (selectedVariant) {
      // Checkout can promote this row between the read above and this batch.
      // The UPDATE then matches nothing, and the items must not move either:
      // they are the order's now, not the lead's (PR-3).
      statements.push(
        database
          .prepare(
            `DELETE FROM order_items
             WHERE order_id IN (
               SELECT id FROM orders WHERE id = ? AND shipping_status = 'abandoned'
             )`,
          )
          .bind(existing.id),
        database
          .prepare(
            `INSERT INTO order_items (order_id, variant_id, quantity, unit_price)
             SELECT id, ?, 1, ?
             FROM orders
             WHERE id = ? AND shipping_status = 'abandoned'`,
          )
          .bind(selectedVariant.id, totalAmount, existing.id),
      );
    }
    await database.batch(statements);
    return {
      id: existing.id,
      orderNumber: existing.order_number,
      customerPhone,
      action: "updated",
    };
  }

  const store = await database
    .prepare("SELECT id FROM stores ORDER BY id LIMIT 1")
    .first<{ id: number }>();
  if (!store) throw new Error("Store belum dikonfigurasi.");

  const orderNumber = await allocateOrderNumber(database, "ABN");
  const statements = [
    database
      .prepare(
        `INSERT INTO orders (
          order_number, store_id, customer_name, customer_phone,
          address, province, city, district,
          payment_method, payment_status, shipping_status,
          total_amount, shipping_cost, discount_amount, cod_service_fee,
          cod_service_fee_vat, cod_fee_bearer, created_at, source_page_path,
          meta_request_context, ad_click_ids
        )
        SELECT
          ?, ?, ?, ?,
          ?, ?, '', '',
          'cod', 'unpaid', 'abandoned',
          ?, 0, 0, 0,
          0, 'buyer', ?, ?,
          ?, ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM orders
          WHERE customer_phone = ?
            AND shipping_status = 'abandoned'
            AND unixepoch(created_at) >= unixepoch('now', '-2 hours')
        )`,
      )
      .bind(
        orderNumber,
        store.id,
        customerName,
        customerPhone,
        address,
        province || "ID-JK",
        totalAmount,
        createdAt,
        input.sourcePagePath || null,
        input.metaRequestContext || null,
        input.adClickIds || null,
        customerPhone,
      ),
  ];
  if (selectedVariant) {
    statements.push(
      database
        .prepare(
          `INSERT INTO order_items (order_id, variant_id, quantity, unit_price)
           SELECT o.id, pv.id, 1, ?
           FROM orders o
           INNER JOIN product_variants pv ON pv.id = ?
           WHERE o.order_number = ?`,
        )
        .bind(totalAmount, selectedVariant.id, orderNumber),
    );
  }
  statements.push(
    database
      .prepare(
        `SELECT id, order_number
         FROM orders
         WHERE customer_phone = ?
           AND shipping_status = 'abandoned'
           AND unixepoch(created_at) >= unixepoch('now', '-2 hours')
         ORDER BY id DESC
         LIMIT 1`,
      )
      .bind(customerPhone),
  );
  const results = await database.batch(statements);
  const row = results.at(-1)?.results?.[0] as
    | { id?: number; order_number?: string }
    | undefined;
  if (!row?.id || !row.order_number) {
    throw new Error("Pesanan tertinggal gagal disimpan.");
  }
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerPhone,
    action: "created",
  };
}


/**
 * The variant an order key names: its numeric id, or its SKU for a caller
 * that only knows the SKU. An id always wins. A merchant can type any SKU, and
 * one store gave a product the SKUs "1" and "2" — the ids of another product's
 * variants — so `id = ? OR sku = ?` matched both and every order for the
 * first product was saved as the second, at the second's price. The SKU is
 * consulted only when no variant has that id at all, so an inactive product's
 * id cannot fall through to a different product's SKU either.
 */
export async function findOrderVariant(database: D1Database, variantKey: string) {
  return database
    .prepare(
      `
      SELECT pv.id, pv.price, p.product_type
      FROM product_variants pv
      INNER JOIN products p ON p.id = pv.product_id
      WHERE p.is_active = 1
        AND (
          CAST(pv.id AS TEXT) = ?
          OR (
            pv.sku = ?
            AND NOT EXISTS (SELECT 1 FROM product_variants byId WHERE CAST(byId.id AS TEXT) = ?)
          )
        )
      ORDER BY pv.id
      LIMIT 1
    `,
    )
    .bind(variantKey, variantKey, variantKey)
    .first<{ id: number; price: number; product_type?: string | null }>();
}

/**
 * What a digital order stores in its NOT NULL address columns (DIGITAL-PRODUCTS-SPEC
 * §2.3): '-', never a made-up place. "Digital" was hashed into Meta's city and
 * state as if it were the buyer's (review finding 3); '-' normalises to nothing.
 */
export const DIGITAL_ORDER_ADDRESS = {
  address: "-",
  province: "-",
  city: "-",
  district: "-",
} as const;

/**
 * Stand-in values a digital checkout body is *parsed* with: the shared checkout
 * schema wants an address, and a digital buyer has none. Never stored —
 * `persistOrder` writes `DIGITAL_ORDER_ADDRESS` for a digital variant.
 */
export const DIGITAL_PARSE_ADDRESS = {
  address: "Produk digital tanpa pengiriman",
  province: "Digital",
  district: "Digital",
  postal_code: "",
} as const;

/** Whether this variant key names an active digital product (the checkout routes branch on it). */
export async function isDigitalVariant(database: D1Database, variantKey: string): Promise<boolean> {
  if (!variantKey) return false;
  return (await findOrderVariant(database, variantKey))?.product_type === "digital";
}

/** Raised when a physical order cannot ship yet (a hybrid store without its warehouse, Mengantar key or courier). */
export class PhysicalShippingNotReadyError extends OrderInputError {
  constructor() {
    super("Pengiriman produk fisik belum siap di toko ini. Produk digital tetap bisa dibeli.");
    this.name = "PhysicalShippingNotReadyError";
  }
}

export async function persistOrder(
  database: D1Database,
  submitted: PersistOrderInput,
): Promise<PersistedOrder> {
  const variant = await findOrderVariant(database, submitted.variantKey);
  if (!variant) throw new OrderInputError("Varian produk tidak ditemukan.");
  // A digital order ships nothing: whatever the request said, it stores no address,
  // destination, courier or warehouse (§2.3).
  const input: PersistOrderInput = variant.product_type === "digital"
    ? { ...submitted, ...DIGITAL_ORDER_ADDRESS, postalCode: undefined, destinationAreaId: undefined, courierCode: undefined, courierService: undefined, warehouseId: undefined }
    : submitted;
  // DIGITAL-PRODUCTS-SPEC §2.3/§6.3: the product decides, never the request. A
  // digital product is paid before access — never COD — and ships nothing. Every
  // order path (checkout, middle form, headless, CS conversion) passes here.
  const fulfillmentType = variant.product_type === "digital" ? "digital" : "physical";
  if (fulfillmentType === "digital") {
    if (input.paymentMethod === "cod") {
      throw new OrderInputError("Produk digital tidak bisa dibayar COD. Pilih QRIS, Virtual Account, atau transfer bank.");
    }
    if (input.shippingCost !== 0) throw new OrderInputError("Produk digital tidak memakai ongkos kirim.");
  }
  // No stock gate. This store sells on demand rather than from a counted
  // shelf, so an order is never refused for a stock figure and the figure is
  // never spent (ADR-023). Price, weight and identity still come from D1.

  const store = await database
    .prepare("SELECT id, cod_fee_bearer, catalog_mode FROM stores ORDER BY id LIMIT 1")
    .first<{ id: number; cod_fee_bearer: string | null; catalog_mode?: string | null }>();
  if (!store) throw new Error("Store belum dikonfigurasi.");
  // Review findings 1-2 (§3): the catalog mode decides what is for sale, and a
  // physical order needs shipping. A digital store sells no physical product and
  // a physical store no digital one, whatever page or POST asks. A hybrid store
  // with a digital product on sale may be open without shipping (either track
  // opens it), so its physical products wait until it can ship them while the
  // digital ones keep selling. Any other store is open only when it can ship
  // (the storefront gate), so the check would only repeat that.
  // A row with no mode predates 0084: a purely physical store (0084 itself sets 'hybrid', NOT NULL).
  const catalogMode = store.catalog_mode === "digital" || store.catalog_mode === "hybrid" ? store.catalog_mode : "physical";
  if (catalogMode !== "hybrid" && catalogMode !== fulfillmentType) {
    throw new OrderInputError("Produk ini tidak dijual di toko ini.");
  }
  if (catalogMode === "hybrid" && fulfillmentType === "physical") {
    const facts = await readReadiness(database);
    if (facts.digitalProduct && !physicalShippingReady(facts)) throw new PhysicalShippingNotReadyError();
  }
  const sellerBankAccount =
    input.paymentMethod === "manual_transfer"
      ? await database
          .prepare(
            `SELECT id, bank_code, account_holder, account_number
             FROM seller_bank_accounts
             WHERE id = ? AND store_id = ? AND is_active = 1
             LIMIT 1`,
          )
          .bind(input.sellerBankAccountId || 0, store.id)
          .first<{
            id: number;
            bank_code: string;
            account_holder: string;
            account_number: string;
          }>()
      : null;
  if (input.paymentMethod === "manual_transfer" && !sellerBankAccount) {
    throw new OrderInputError("Rekening transfer tidak tersedia.");
  }

  const unitPrice = Number(variant.price);
  const orderAmount = unitPrice * input.quantity + input.shippingCost;
  const codFeeBearer = normalizePaymentFeeBearer(store.cod_fee_bearer);
  const codFee =
    input.paymentMethod === "cod"
      ? calculateCodFeeBreakdown(orderAmount)
      : calculateCodFeeBreakdown(0);
  const totalAmount =
    input.paymentMethod === "cod"
      ? calculateCodCustomerTotal(orderAmount, codFeeBearer)
      : orderAmount;
  const createdAt = new Date().toISOString();
  const paymentStatus =
    input.paymentMethod === "cod" ? "unpaid" : "pending";
  const checkoutFingerprint = await createCheckoutFingerprint({
    storeId: store.id,
    variantId: variant.id,
    order: input,
    totalAmount,
  });
  const dedupeExpiresAt = new Date(
    new Date(createdAt).getTime() + CHECKOUT_DEDUPE_WINDOW_MS,
  ).toISOString();
  const existingOrder = await findCanonicalOrder(
    database,
    checkoutFingerprint,
    input.submitToken,
    createdAt,
  );
  if (existingOrder) return persistedOrderFromRow(existingOrder, false);

  const abandonedOrder = await database
    .prepare(
      `SELECT id, order_number, public_status_token
       FROM orders
       WHERE customer_phone = ?
         AND shipping_status = 'abandoned'
         AND unixepoch(created_at) >= unixepoch('now', '-2 hours')
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(input.customerPhone)
    .first<{
      id: number;
      order_number: string;
      public_status_token: string | null;
    }>();
  const orderNumber = abandonedOrder
    ? completedNumberFromAbandoned(abandonedOrder.order_number)
    : (await allocateOrderNumber(database, "INV"));
  const publicStatusToken =
    abandonedOrder?.public_status_token || crypto.randomUUID();

  try {
    const orderStatement = abandonedOrder
      ? database
          .prepare(
            `UPDATE orders
             SET order_number = ?,
                 submit_token = ?,
                 public_status_token = ?,
                 customer_name = ?,
                 customer_phone = ?,
                 customer_email = ?,
                 address = ?,
                 province = ?,
                 city = ?,
                 district = ?,
                 postal_code = ?,
                 warehouse_id = ?,
                 total_amount = ?,
                 shipping_cost = ?,
                 discount_amount = 0,
                 cod_service_fee = ?,
                 cod_service_fee_vat = ?,
                 cod_fee_bearer = ?,
                 payment_method = ?,
                 payment_status = ?,
                 shipping_status = 'pending',
                 destination_area_id = ?,
                 courier_code = ?,
                 courier_service = ?,
                 ad_click_ids = COALESCE(?, ad_click_ids),
                 meta_request_context = COALESCE(?, meta_request_context),
                 source_page_path = COALESCE(?, source_page_path),
                 seller_bank_account_id = ?,
                 seller_bank_code = ?,
                 seller_bank_name = ?,
                 seller_account_holder = ?,
                 seller_account_number = ?,
                 checkout_fingerprint = ?,
                 checkout_dedupe_expires_at = ?,
                 fulfillment_type = ?
             WHERE id = ?
               AND customer_phone = ?
               AND shipping_status = 'abandoned'
               AND checkout_fingerprint IS NULL
               AND unixepoch(created_at) >= unixepoch('now', '-2 hours')`,
          )
          .bind(
            orderNumber,
            input.submitToken,
            publicStatusToken,
            input.customerName,
            input.customerPhone,
            input.customerEmail || null,
            input.address,
            input.province,
            input.city,
            input.district,
            input.postalCode || null,
            input.warehouseId || null,
            totalAmount,
            input.shippingCost,
            codFee.serviceFee,
            codFee.vat,
            codFeeBearer,
            input.paymentMethod,
            paymentStatus,
            input.destinationAreaId || null,
            input.courierCode || null,
            input.courierService || null,
            input.adClickIds || null,
            input.metaRequestContext || null,
            input.sourcePagePath || null,
            sellerBankAccount?.id || null,
            sellerBankAccount?.bank_code || null,
            sellerBankAccount
              ? paymentBrandLabel(sellerBankAccount.bank_code)
              : null,
            sellerBankAccount?.account_holder || null,
            sellerBankAccount?.account_number || null,
            checkoutFingerprint,
            dedupeExpiresAt,
            fulfillmentType,
            abandonedOrder.id,
            input.customerPhone,
          )
      : database
          .prepare(
            `INSERT OR IGNORE INTO orders (
              order_number, submit_token, public_status_token, store_id, warehouse_id,
              customer_name, customer_phone, customer_email, address, province, city, district, postal_code,
              total_amount, shipping_cost, cod_service_fee, cod_service_fee_vat,
              cod_fee_bearer, payment_method, payment_status, shipping_status,
              destination_area_id, courier_code, courier_service, ad_click_ids,
              meta_request_context, source_page_path,
              seller_bank_account_id, seller_bank_code, seller_bank_name,
              seller_account_holder, seller_account_number, created_at,
              checkout_fingerprint, checkout_dedupe_expires_at, fulfillment_type
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )`,
          )
          .bind(
            orderNumber,
            input.submitToken,
            publicStatusToken,
            store.id,
            input.warehouseId || null,
            input.customerName,
            input.customerPhone,
            input.customerEmail || null,
            input.address,
            input.province,
            input.city,
            input.district,
            input.postalCode || null,
            totalAmount,
            input.shippingCost,
            codFee.serviceFee,
            codFee.vat,
            codFeeBearer,
            input.paymentMethod,
            paymentStatus,
            input.destinationAreaId || null,
            input.courierCode || null,
            input.courierService || null,
            input.adClickIds || null,
            input.metaRequestContext || null,
            input.sourcePagePath || null,
            sellerBankAccount?.id || null,
            sellerBankAccount?.bank_code || null,
            sellerBankAccount
              ? paymentBrandLabel(sellerBankAccount.bank_code)
              : null,
            sellerBankAccount?.account_holder || null,
            sellerBankAccount?.account_number || null,
            createdAt,
            checkoutFingerprint,
            dedupeExpiresAt,
            fulfillmentType,
          );

    const identityPredicate = abandonedOrder
      ? "id = ? AND submit_token = ?"
      : "order_number = ? AND submit_token = ?";
    const identityBindings: [number | string, string] = [
      abandonedOrder?.id || orderNumber,
      input.submitToken,
    ];
    const statements = [
      database
        .prepare(
          `UPDATE orders
           SET checkout_fingerprint = NULL,
               checkout_dedupe_expires_at = NULL
           WHERE checkout_fingerprint = ?
             AND (
               checkout_dedupe_expires_at <= ?
               OR shipping_status NOT IN ('pending', 'processing', 'shipped')
               OR payment_status IN ('failed', 'refunded', 'cancelled')
             )`,
        )
        .bind(checkoutFingerprint, createdAt),
      orderStatement,
    ];
    if (abandonedOrder) {
      statements.push(
        database
          .prepare(
            `DELETE FROM order_items
             WHERE order_id IN (
               SELECT id FROM orders WHERE ${identityPredicate}
             )`,
          )
          .bind(...identityBindings),
      );
    }
    statements.push(
      database
        .prepare(
          `INSERT INTO order_items (order_id, variant_id, quantity, unit_price, weight_grams)
           SELECT id, ?, ?, ?, (SELECT weight_grams FROM product_variants WHERE id = ?)
           FROM orders
           WHERE ${identityPredicate}`,
        )
        .bind(
          variant.id,
          input.quantity,
          unitPrice,
          variant.id,
          ...identityBindings,
        ),
      database
        .prepare(
          `SELECT o.id, o.order_number, o.public_status_token, o.total_amount,
                  oi.unit_price, o.cod_service_fee, o.cod_service_fee_vat,
                  o.cod_fee_bearer, o.seller_bank_account_id, o.seller_bank_code,
                  o.seller_bank_name, o.seller_account_holder, o.seller_account_number
           FROM orders o
           INNER JOIN order_items oi ON oi.order_id = o.id
           WHERE (
               (o.checkout_fingerprint = ? AND o.checkout_dedupe_expires_at > ?)
               OR o.submit_token = ?
             )
             AND o.shipping_status IN ('pending', 'processing', 'shipped')
             AND o.payment_status NOT IN ('failed', 'refunded', 'cancelled')
           ORDER BY o.id DESC, oi.id ASC
           LIMIT 1`,
        )
        .bind(checkoutFingerprint, createdAt, input.submitToken),
    );
    const results = await database.batch(statements);
    const row = results.at(-1)?.results?.[0] as CanonicalOrderRow | undefined;
    const created = Number(results[1]?.meta?.changes || 0) > 0;
    if (!row?.id) {
      if (!created) {
        throw new DuplicateSubmissionError(
          "Permintaan duplikat terdeteksi. Pesanan sudah diproses.",
        );
      }
      throw new Error("Order gagal disimpan.");
    }
    // Recorded here rather than in each of the three checkout routes that call
    // this, so a new entry point cannot forget it. Fail-open by contract: the
    // order is already committed and a buyer must never see a checkout fail
    // because an operator convenience could not be stored (REQ-149).
    if (created) {
      await recordNotification(database, {
        type: "order",
        orderId: row.id,
        orderNumber: row.order_number,
        ...buildOrderNotification({
          orderNumber: row.order_number,
          customerName: input.customerName,
          totalAmount: Number(row.total_amount),
          district: input.district,
          city: input.city,
        }),
      });
    }
    return persistedOrderFromRow(row, created);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("orders.submit_token") ||
      message.includes("orders_submit_token_unique")
    ) {
      throw new DuplicateSubmissionError(
        "Permintaan duplikat terdeteksi. Pesanan sudah diproses.",
      );
    }
    // The `product_variants_stock_nonnegative` trigger (migration 0003) is
    // still in the schema and still correct, but checkout no longer writes to
    // `stock` at all (ADR-023), so it can no longer fire from here. The branch
    // that translated it into a buyer-facing message is gone with it.
    throw error;
  }
}
