/**
 * The digital checkout's pure parts (DIGITAL-PRODUCTS-SPEC §5.1), kept here so
 * the test runner reaches them: which payment rails a digital product offers,
 * and the body it posts to `/api/submit-order`. The server decides again —
 * `/api/submit-order` and `persistOrder` refuse COD and shipping for a digital
 * variant whatever this sends.
 */

export type DigitalPaymentOption = {
  code: string;
  paymentMethod: "qris" | "bank_transfer" | "manual_transfer";
  channelCode?: string;
  sellerBankAccountId?: number;
  label: string;
  description: string;
};

type RawOption = {
  code?: unknown;
  payment_method?: unknown;
  channel_code?: unknown;
  seller_bank_account_id?: unknown;
  name?: unknown;
  description?: unknown;
  is_active?: unknown;
};

const PREPAID = new Set(["qris", "bank_transfer", "manual_transfer"]);

/** The active prepaid rails from `/api/payment-methods`, in its order; never COD. */
export function digitalPaymentOptions(payload: unknown): DigitalPaymentOption[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const options: DigitalPaymentOption[] = [];
  for (const raw of rows as RawOption[]) {
    if (!raw || raw.is_active !== true) continue;
    const method = String(raw.payment_method ?? "");
    if (!PREPAID.has(method)) continue;
    const code = String(raw.code ?? "").trim();
    if (!code) continue;
    const bankAccountId = Number(raw.seller_bank_account_id);
    if (method === "manual_transfer" && !(Number.isSafeInteger(bankAccountId) && bankAccountId > 0)) continue;
    if (method !== "manual_transfer" && !String(raw.channel_code ?? "").trim()) continue;
    options.push({
      code,
      paymentMethod: method as DigitalPaymentOption["paymentMethod"],
      ...(method === "manual_transfer" ? { sellerBankAccountId: bankAccountId } : { channelCode: String(raw.channel_code) }),
      label: String(raw.name ?? code),
      description: String(raw.description ?? ""),
    });
  }
  return options;
}

/** The `/api/submit-order` body of a digital order: contact, variant and rail; no address, no courier. */
export function digitalOrderBody(input: {
  submitToken: string;
  honeypot: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  variantId: string;
  option: DigitalPaymentOption;
  sourcePagePath: string;
}): Record<string, unknown> {
  return {
    submit_token: input.submitToken,
    website: input.honeypot,
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    variant_id: input.variantId,
    quantity: 1,
    payment_method: input.option.paymentMethod,
    ...(input.option.channelCode ? { payment_channel: input.option.channelCode } : {}),
    ...(input.option.sellerBankAccountId ? { seller_bank_account_id: input.option.sellerBankAccountId } : {}),
    source_page_path: input.sourcePagePath.slice(0, 500),
  };
}
