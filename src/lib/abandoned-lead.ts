import {
  calculateCodCustomerTotal,
  calculateCodFeeBreakdown,
  normalizePaymentFeeBearer,
} from "./payment-fee-policy.ts";
import { isValidWa62, normalizePhone } from "./validation.ts";
import { paymentBrandLabel } from "./payment-brand.ts";
import type { PaymentSwitchTarget } from "./payment-switch.ts";

// Restated, not imported: this module also feeds the lead list island (through
// lead-follow-up.ts), and catalog.ts / order-persistence.ts pull server code
// into that bundle. `lead-conversion-kind.test.ts` pins both to their owners.
/** `CATALOG_MODE_FILTER_SQL` (catalog.ts): what the store sells in its mode. */
export const LEAD_CATALOG_MODE_SQL = `COALESCE((SELECT catalog_mode FROM stores ORDER BY id LIMIT 1), 'hybrid') IN ('hybrid', p.product_type)`;
/** `DIGITAL_ORDER_ADDRESS` (order-persistence.ts): '-', never a made-up place. */
export const LEAD_DIGITAL_ADDRESS = { address: "-", province: "-", city: "-", district: "-" } as const;

export const LEAD_FOLLOW_UP_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "not_interested",
] as const;

export type LeadFollowUpStatus = (typeof LEAD_FOLLOW_UP_STATUSES)[number];

/** The words the lead list and its CSV export use for each status. */
export const LEAD_FOLLOW_UP_LABELS: Record<LeadFollowUpStatus, string> = {
  new: "Belum dihubungi",
  contacted: "Sudah dihubungi",
  qualified: "Berminat",
  not_interested: "Tidak berminat",
};

export class AbandonedLeadError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AbandonedLeadError";
    this.status = status;
  }
}

export type UpdateAbandonedLeadInput = {
  customerName?: string;
  customerPhone?: string;
  followUpStatus?: LeadFollowUpStatus;
  followUpNote?: string;
  followedUpBy?: string;
  variantId?: number;
  quantity?: number;
};

export type ConvertAbandonedLeadInput = {
  customerName: string;
  customerPhone: string;
  address: string;
  district: string;
  city: string;
  province: string;
  postalCode?: string;
  destinationAreaId: string;
  variantId: number;
  quantity: number;
  warehouseId: number;
  courierCode: string;
  courierService: string;
  shippingCost: number;
  followedUpBy: string;
};

type AbandonedLeadRow = {
  id: number;
  order_number: string;
  shipping_status: string;
};

type ActiveVariantRow = {
  id: number;
  price: number;
  product_type: string | null;
};

/**
 * A digital lead becomes a prepaid digital order (DIGITAL-PRODUCTS-SPEC §2.3):
 * no address, courier or shipping, never COD. The buyer pays from the order's
 * own /payment page; access opens when the payment settles.
 */
export type ConvertDigitalLeadInput = {
  customerName: string;
  customerPhone: string;
  /** The address the payment provider is given; checkout mints the same one when the buyer gives none. */
  customerEmail: string;
  variantId: number;
  quantity: number;
  payment: PaymentSwitchTarget;
  followedUpBy: string;
};

function normalizeLeadIdentity(customerName: string, customerPhone: string) {
  const name = customerName.trim().slice(0, 100);
  const phone = normalizePhone(customerPhone).slice(0, 40);
  if (name.length < 2) {
    throw new AbandonedLeadError("Nama minimal 2 karakter.", 422);
  }
  if (!isValidWa62(phone)) {
    throw new AbandonedLeadError("Nomor WhatsApp tidak valid.", 422);
  }
  return { name, phone };
}

async function loadAbandonedLead(database: D1Database, orderId: number) {
  return database
    .prepare(
      `SELECT id, order_number, shipping_status
       FROM orders
       WHERE id = ? AND shipping_status = 'abandoned'
       LIMIT 1`,
    )
    .bind(orderId)
    .first<AbandonedLeadRow>();
}

export async function assertAbandonedLeadExists(
  database: D1Database,
  orderId: number,
) {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new AbandonedLeadError("ID pesanan tertinggal tidak valid.");
  }
  const lead = await loadAbandonedLead(database, orderId);
  if (!lead) {
    throw new AbandonedLeadError("Pesanan tertinggal tidak ditemukan.", 404);
  }
  return lead;
}

/**
 * An active variant the store sells in its catalog mode: a physical store
 * converts no digital product and a digital store no physical one, as
 * `persistOrder` refuses at checkout.
 */
export async function loadActiveVariant(database: D1Database, variantId: number) {
  return database
    .prepare(
      `SELECT pv.id, pv.price, p.product_type
       FROM product_variants pv
       INNER JOIN products p ON p.id = pv.product_id
       WHERE pv.id = ? AND p.is_active = 1 AND ${LEAD_CATALOG_MODE_SQL}
       LIMIT 1`,
    )
    .bind(variantId)
    .first<ActiveVariantRow>();
}

export async function updateAbandonedLead(
  database: D1Database,
  orderId: number,
  input: UpdateAbandonedLeadInput,
) {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new AbandonedLeadError("ID pesanan tertinggal tidak valid.");
  }
  const lead = await loadAbandonedLead(database, orderId);
  if (!lead) {
    throw new AbandonedLeadError("Pesanan tertinggal tidak ditemukan.", 404);
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.customerName !== undefined || input.customerPhone !== undefined) {
    const current = await database
      .prepare(
        `SELECT customer_name, customer_phone
         FROM orders WHERE id = ? AND shipping_status = 'abandoned'`,
      )
      .bind(orderId)
      .first<{ customer_name: string; customer_phone: string }>();
    if (!current) {
      throw new AbandonedLeadError("Pesanan tertinggal tidak ditemukan.", 404);
    }
    const identity = normalizeLeadIdentity(
      input.customerName ?? current.customer_name,
      input.customerPhone ?? current.customer_phone,
    );
    assignments.push("customer_name = ?", "customer_phone = ?");
    values.push(identity.name, identity.phone);
  }
  if (input.followUpStatus !== undefined) {
    if (!LEAD_FOLLOW_UP_STATUSES.includes(input.followUpStatus)) {
      throw new AbandonedLeadError("Status follow-up tidak valid.", 422);
    }
    assignments.push(
      "lead_follow_up_status = ?",
      "lead_followed_up_at = ?",
      "lead_followed_up_by = ?",
    );
    values.push(
      input.followUpStatus,
      new Date().toISOString(),
      input.followedUpBy?.trim().slice(0, 100) || null,
    );
  }
  if (input.followUpNote !== undefined) {
    assignments.push("lead_follow_up_note = ?");
    values.push(input.followUpNote.trim().slice(0, 1000) || null);
  }

  let variant: ActiveVariantRow | null = null;
  const quantity = input.quantity ?? 1;
  if (input.variantId !== undefined || input.quantity !== undefined) {
    if (!Number.isInteger(input.variantId) || Number(input.variantId) < 1) {
      throw new AbandonedLeadError("Varian produk wajib dipilih.", 422);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new AbandonedLeadError("Jumlah produk harus 1 sampai 100.", 422);
    }
    variant = await loadActiveVariant(database, Number(input.variantId));
    if (!variant) {
      throw new AbandonedLeadError("Varian produk aktif tidak ditemukan.", 404);
    }
    assignments.push("total_amount = ?");
    values.push(Number(variant.price) * quantity);
  }

  if (assignments.length === 0 && !variant) {
    throw new AbandonedLeadError("Tidak ada perubahan yang dikirim.");
  }

  const statements = [];
  if (assignments.length > 0) {
    statements.push(
      database
        .prepare(
          `UPDATE orders
           SET ${assignments.join(", ")}
           WHERE id = ? AND shipping_status = 'abandoned'`,
        )
        .bind(...values, orderId),
    );
  }
  if (variant) {
    statements.push(
      database
        .prepare(
          `DELETE FROM order_items
           WHERE order_id = ?
             AND EXISTS (
               SELECT 1 FROM orders
               WHERE id = ? AND shipping_status = 'abandoned'
             )`,
        )
        .bind(orderId, orderId),
      database
        .prepare(
          `INSERT INTO order_items (order_id, variant_id, quantity, unit_price)
           SELECT id, ?, ?, ?
           FROM orders
           WHERE id = ? AND shipping_status = 'abandoned'`,
        )
        .bind(variant.id, quantity, Number(variant.price), orderId),
    );
  }
  const results = await database.batch(statements);
  if (!results[0]?.meta?.changes) {
    throw new AbandonedLeadError(
      "Pesanan tertinggal sudah diproses oleh operator lain.",
      409,
    );
  }
  return { id: lead.id, orderNumber: lead.order_number };
}

function completedNumberFromLead(orderNumber: string) {
  if (!/^ABN-\d{5,}$/.test(orderNumber)) {
    throw new AbandonedLeadError("Nomor pesanan tertinggal tidak valid.", 409);
  }
  return `INV-${orderNumber.slice(4)}`;
}

/**
 * Promotes one lead to a pending order. The conversion token ties the item
 * rewrite to the winning guarded update, so two operators converting the same
 * lead cannot both write its items. This deliberately never calls Mengantar.
 */
export async function convertAbandonedLead(
  database: D1Database,
  orderId: number,
  input: ConvertAbandonedLeadInput,
) {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new AbandonedLeadError("ID pesanan tertinggal tidak valid.");
  }
  const identity = normalizeLeadIdentity(input.customerName, input.customerPhone);
  const address = input.address.trim().slice(0, 500);
  const district = input.district.trim().slice(0, 120);
  const city = input.city.trim().slice(0, 120);
  const province = input.province.trim().slice(0, 120);
  const destinationAreaId = input.destinationAreaId.trim().slice(0, 120);
  const courierCode = input.courierCode.trim().slice(0, 50);
  const courierService = input.courierService.trim().slice(0, 120);
  const postalCode = input.postalCode?.trim().slice(0, 10) || null;
  if (
    address.length < 10 ||
    district.length < 2 ||
    city.length < 2 ||
    province.length < 2 ||
    !destinationAreaId ||
    !courierCode ||
    !courierService ||
    !Number.isInteger(input.warehouseId) ||
    input.warehouseId < 1
  ) {
    throw new AbandonedLeadError(
      "Lengkapi data pembeli, alamat, kecamatan, dan ekspedisi sebelum mengubah menjadi order.",
      422,
    );
  }
  if (postalCode && !/^\d{5}$/.test(postalCode)) {
    throw new AbandonedLeadError("Kode pos harus 5 digit.", 422);
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) {
    throw new AbandonedLeadError("Jumlah produk harus 1 sampai 100.", 422);
  }
  if (!Number.isFinite(input.shippingCost) || input.shippingCost < 0) {
    throw new AbandonedLeadError("Biaya pengiriman tidak valid.", 422);
  }

  const [lead, variant, store] = await Promise.all([
    loadAbandonedLead(database, orderId),
    loadActiveVariant(database, input.variantId),
    database
      .prepare("SELECT cod_fee_bearer FROM stores ORDER BY id LIMIT 1")
      .first<{ cod_fee_bearer: string | null }>(),
  ]);
  if (!lead) {
    throw new AbandonedLeadError("Pesanan tertinggal tidak ditemukan.", 404);
  }
  if (!variant) {
    throw new AbandonedLeadError("Varian produk aktif tidak ditemukan.", 404);
  }
  // A digital product is never COD and ships nothing: it converts through
  // `convertDigitalLead`, never into a COD order with a courier.
  if (variant.product_type === "digital") {
    throw new AbandonedLeadError("Produk digital dibayar di muka tanpa alamat dan kurir. Pilih metode pembayaran.", 422);
  }
  if (!store) throw new AbandonedLeadError("Store belum dikonfigurasi.", 503);

  const orderNumber = completedNumberFromLead(lead.order_number);
  const unitPrice = Number(variant.price);
  const baseAmount = unitPrice * input.quantity + input.shippingCost;
  const feeBearer = normalizePaymentFeeBearer(store.cod_fee_bearer);
  const codFee = calculateCodFeeBreakdown(baseAmount);
  const totalAmount = calculateCodCustomerTotal(baseAmount, feeBearer);
  const conversionToken = `admin_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const statements = [
    database
      .prepare(
        `UPDATE orders
         SET order_number = ?,
             submit_token = ?,
             public_status_token = COALESCE(public_status_token, ?),
             customer_name = ?,
             customer_phone = ?,
             address = ?,
             district = ?,
             city = ?,
             province = ?,
             postal_code = ?,
             destination_area_id = ?,
             warehouse_id = ?,
             courier_code = ?,
             courier_service = ?,
             shipping_cost = ?,
             total_amount = ?,
             cod_service_fee = ?,
             cod_service_fee_vat = ?,
             cod_fee_bearer = ?,
             payment_method = 'cod',
             payment_status = 'unpaid',
             shipping_status = 'pending',
             lead_follow_up_status = 'converted',
             lead_followed_up_at = ?,
             lead_followed_up_by = ?,
             confirmed_at = ?
         WHERE id = ?
           AND shipping_status = 'abandoned'
           AND EXISTS (
             SELECT 1
             FROM product_variants pv
             INNER JOIN products p ON p.id = pv.product_id
             WHERE pv.id = ?
               AND p.is_active = 1
               AND p.product_type = 'physical'
           )`,
      )
      .bind(
        orderNumber,
        conversionToken,
        crypto.randomUUID(),
        identity.name,
        identity.phone,
        address,
        district,
        city,
        province,
        postalCode,
        destinationAreaId,
        input.warehouseId,
        courierCode,
        courierService,
        Math.round(input.shippingCost),
        totalAmount,
        codFee.serviceFee,
        codFee.vat,
        feeBearer,
        now,
        input.followedUpBy.trim().slice(0, 100) || null,
        now,
        orderId,
        variant.id,
      ),
    database
      .prepare(
        `DELETE FROM order_items
         WHERE order_id = ?
           AND EXISTS (
             SELECT 1 FROM orders
             WHERE id = ?
               AND submit_token = ?
               AND shipping_status = 'pending'
           )`,
      )
      .bind(orderId, orderId, conversionToken),
    database
      .prepare(
        // The variant's weight at conversion, as checkout records it (A-397):
        // dispatch sends this, not whatever the variant weighs later.
        `INSERT INTO order_items (order_id, variant_id, quantity, unit_price, weight_grams)
         SELECT id, ?, ?, ?, (SELECT weight_grams FROM product_variants WHERE id = ?)
         FROM orders
         WHERE id = ?
           AND submit_token = ?
           AND shipping_status = 'pending'`,
      )
      .bind(variant.id, input.quantity, unitPrice, variant.id, orderId, conversionToken),
    database
      .prepare(
        `SELECT id, order_number
         FROM orders
         WHERE id = ?
           AND submit_token = ?
           AND shipping_status = 'pending'`,
      )
      .bind(orderId, conversionToken),
  ];
  const results = await database.batch(statements);
  const converted = results.at(-1)?.results?.[0] as
    | { id?: number; order_number?: string }
    | undefined;
  if (!converted?.id || !converted.order_number) {
    throw new AbandonedLeadError(
      "Pesanan tertinggal sudah diproses oleh operator lain.",
      409,
    );
  }
  return { id: converted.id, orderNumber: converted.order_number };
}

export async function convertDigitalLead(
  database: D1Database,
  orderId: number,
  input: ConvertDigitalLeadInput,
) {
  if (!Number.isInteger(orderId) || orderId < 1) {
    throw new AbandonedLeadError("ID pesanan tertinggal tidak valid.");
  }
  const identity = normalizeLeadIdentity(input.customerName, input.customerPhone);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100) {
    throw new AbandonedLeadError("Jumlah produk harus 1 sampai 100.", 422);
  }
  const [lead, variant, store] = await Promise.all([
    loadAbandonedLead(database, orderId),
    loadActiveVariant(database, input.variantId),
    database.prepare("SELECT id FROM stores ORDER BY id LIMIT 1").first<{ id: number }>(),
  ]);
  if (!lead) throw new AbandonedLeadError("Pesanan tertinggal tidak ditemukan.", 404);
  if (!variant) throw new AbandonedLeadError("Varian produk aktif tidak ditemukan.", 404);
  if (variant.product_type !== "digital") {
    throw new AbandonedLeadError("Produk fisik perlu alamat dan kurir. Lengkapi pengiriman.", 422);
  }
  if (!store) throw new AbandonedLeadError("Store belum dikonfigurasi.", 503);

  let bank: { id: number; bank_code: string; account_holder: string; account_number: string } | null = null;
  if (input.payment.payment_method === "manual_transfer") {
    bank = await database
      .prepare(
        `SELECT id, bank_code, account_holder, account_number FROM seller_bank_accounts
         WHERE id = ? AND store_id = ? AND is_active = 1 LIMIT 1`,
      )
      .bind(input.payment.seller_bank_account_id, store.id)
      .first<{ id: number; bank_code: string; account_holder: string; account_number: string }>();
    if (!bank) throw new AbandonedLeadError("Rekening transfer tidak tersedia.", 422);
  }

  const orderNumber = completedNumberFromLead(lead.order_number);
  const unitPrice = Number(variant.price);
  const totalAmount = unitPrice * input.quantity;
  const conversionToken = `admin_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE orders
         SET order_number = ?,
             submit_token = ?,
             public_status_token = COALESCE(public_status_token, ?),
             customer_name = ?,
             customer_phone = ?,
             customer_email = COALESCE(NULLIF(customer_email, ''), ?),
             address = ?, district = ?, city = ?, province = ?,
             postal_code = NULL, destination_area_id = NULL, warehouse_id = NULL,
             courier_code = NULL, courier_service = NULL,
             shipping_cost = 0, discount_amount = 0,
             total_amount = ?,
             cod_service_fee = 0, cod_service_fee_vat = 0,
             payment_method = ?,
             payment_status = 'pending',
             shipping_status = 'pending',
             fulfillment_type = 'digital',
             shipping_channel = 'mengantar',
             seller_bank_account_id = ?, seller_bank_code = ?, seller_bank_name = ?,
             seller_account_holder = ?, seller_account_number = ?,
             lead_follow_up_status = 'converted',
             lead_followed_up_at = ?,
             lead_followed_up_by = ?
         WHERE id = ?
           AND shipping_status = 'abandoned'
           AND EXISTS (
             SELECT 1
             FROM product_variants pv
             INNER JOIN products p ON p.id = pv.product_id
             WHERE pv.id = ?
               AND p.is_active = 1
               AND p.product_type = 'digital'
           )`,
      )
      .bind(
        orderNumber,
        conversionToken,
        crypto.randomUUID(),
        identity.name,
        identity.phone,
        input.customerEmail.trim().slice(0, 160) || null,
        LEAD_DIGITAL_ADDRESS.address,
        LEAD_DIGITAL_ADDRESS.district,
        LEAD_DIGITAL_ADDRESS.city,
        LEAD_DIGITAL_ADDRESS.province,
        totalAmount,
        input.payment.payment_method,
        bank?.id ?? null,
        bank?.bank_code ?? null,
        bank ? paymentBrandLabel(bank.bank_code) : null,
        bank?.account_holder ?? null,
        bank?.account_number ?? null,
        now,
        input.followedUpBy.trim().slice(0, 100) || null,
        orderId,
        variant.id,
      ),
    database
      .prepare(
        `DELETE FROM order_items
         WHERE order_id = ?
           AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND submit_token = ? AND shipping_status = 'pending')`,
      )
      .bind(orderId, orderId, conversionToken),
    database
      .prepare(
        `INSERT INTO order_items (order_id, variant_id, quantity, unit_price, weight_grams)
         SELECT id, ?, ?, ?, (SELECT weight_grams FROM product_variants WHERE id = ?)
         FROM orders
         WHERE id = ? AND submit_token = ? AND shipping_status = 'pending'`,
      )
      .bind(variant.id, input.quantity, unitPrice, variant.id, orderId, conversionToken),
    database
      .prepare(
        `SELECT id, order_number, total_amount FROM orders
         WHERE id = ? AND submit_token = ? AND shipping_status = 'pending'`,
      )
      .bind(orderId, conversionToken),
  ]);
  const converted = results.at(-1)?.results?.[0] as { id?: number; order_number?: string; total_amount?: number } | undefined;
  if (!converted?.id || !converted.order_number) {
    throw new AbandonedLeadError("Pesanan tertinggal sudah diproses oleh operator lain.", 409);
  }
  return { id: converted.id, orderNumber: converted.order_number, totalAmount: Number(converted.total_amount) || totalAmount };
}
