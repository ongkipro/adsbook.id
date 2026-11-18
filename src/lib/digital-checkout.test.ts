import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { digitalEventId, digitalOrderBody, digitalPaymentOptions, digitalSubmitToken } from "./digital-checkout.ts";
import { parseOrderSubmit } from "./order-schema.ts";
import { DIGITAL_PARSE_ADDRESS } from "./order-persistence.ts";

const methods = {
  success: true,
  data: [
    { code: "cod", payment_method: "cod", channel_code: null, name: "COD", is_active: true },
    { code: "QRIS", payment_method: "qris", channel_code: "QRIS", name: "QRIS", description: "Scan", is_active: true },
    { code: "VABCA", payment_method: "bank_transfer", channel_code: "VABCA", name: "VA BCA", is_active: false },
    { code: "VABNI", payment_method: "bank_transfer", channel_code: "VABNI", name: "VA BNI", is_active: true },
    { code: "MANUAL_3", payment_method: "manual_transfer", channel_code: null, seller_bank_account_id: 3, name: "Transfer Bank BCA", is_active: true },
    { code: "MANUAL_X", payment_method: "manual_transfer", channel_code: null, name: "Transfer tanpa rekening", is_active: true },
  ],
};

test("DIGITAL-PRODUCTS-SPEC §5.1: the digital checkout offers active prepaid rails only — never COD", () => {
  const options = digitalPaymentOptions(methods);
  assert.deepEqual(options.map((option) => option.code), ["QRIS", "VABNI", "MANUAL_3"]);
  assert.deepEqual(options[2], { code: "MANUAL_3", paymentMethod: "manual_transfer", sellerBankAccountId: 3, label: "Transfer Bank BCA", description: "" });
  assert.deepEqual(digitalPaymentOptions(null), []);
  assert.deepEqual(digitalPaymentOptions({ data: "nope" }), []);
});

test("the digital order body carries contact, variant and rail; no address, courier or shipping", () => {
  const [qris, , manual] = digitalPaymentOptions(methods);
  const body = digitalOrderBody({ submitToken: "dig_1234567890abcdef", honeypot: "", customerName: "Budi", customerPhone: "6281234567801", customerEmail: "", variantId: "70", option: qris, sourcePagePath: "/produk/ebook" });
  assert.deepEqual(body, { submit_token: "dig_1234567890abcdef", website: "", customer_name: "Budi", customer_phone: "6281234567801", variant_id: "70", quantity: 1, payment_method: "qris", payment_channel: "QRIS", source_page_path: "/produk/ebook" });
  for (const key of ["address", "district", "province", "location_id", "courier_service_id", "shipping_cost"]) assert.equal(key in body, false, key);
  const withEmail = digitalOrderBody({ submitToken: "dig_1234567890abcdef", honeypot: "", customerName: "Budi", customerPhone: "6281234567801", customerEmail: "budi@example.test", variantId: "70", option: manual, sourcePagePath: "/x" });
  assert.equal(withEmail.customer_email, "budi@example.test");
  assert.equal(withEmail.seller_bank_account_id, 3);
  assert.equal("payment_channel" in withEmail, false);
});

test("review finding 5: a 150-character slug still checks out — the minted ids have a fixed ceiling", () => {
  const slug = `ebook-${"panduan-lengkap-".repeat(9)}`.slice(0, 150);
  assert.equal(slug.length, 150);
  const token = digitalSubmitToken();
  assert.ok(token.length <= 64, `${token.length}`);
  for (const prefix of ["addtocart", "initiatecheckout", "order"]) assert.ok(digitalEventId(prefix, slug).length <= 64, prefix);
  const [option] = digitalPaymentOptions(methods);
  const body = digitalOrderBody({ submitToken: token, honeypot: "", customerName: "Budi Pembeli", customerPhone: "081234567801", customerEmail: "", variantId: "70", option, sourcePagePath: `/produk/${slug}` });
  const parsed = parseOrderSubmit({ ...body, ...DIGITAL_PARSE_ADDRESS });
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.issues[0]?.message);
  // The form never builds a token from the slug again.
  const script = readFileSync(new URL("../scripts/form-digital.ts", import.meta.url), "utf8");
  assert.doesNotMatch(script, /submitToken: `[^`]*productSlug/);
});

