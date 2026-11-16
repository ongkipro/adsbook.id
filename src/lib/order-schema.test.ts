import assert from 'node:assert/strict';
import test from 'node:test';
import { orderSubmitSchema, parseOrderSubmit } from './order-schema.ts';
import { buildWaUrl, renderCrmMessage } from './crm-template.ts';
import { isProvinceExcluded, parseProvinceList } from './province.ts';

const validOrder = {
  customer_name: 'Budi Santoso',
  customer_phone: '6281234567890',
  address: 'Jl. Branjangan Nomor 18A',
  district: 'Krembangan',
  province: 'Jawa Timur',
  postal_code: '60175',
  payment_method: 'cod',
  variant_id: 'AUS-500ML',
  quantity: 1,
  submit_token: 'submit-token-at-least-sixteen',
};

test('order schema normalizes a valid Indonesian mobile number', () => {
  const result = orderSubmitSchema.parse(validOrder);
  assert.equal(result.customer_phone, '6281234567890');
});

test('order schema rejects alphabetic or truncated phone input after normalization', () => {
  assert.equal(orderSubmitSchema.safeParse({ ...validOrder, customer_phone: 'abcdefghijk' }).success, false);
  assert.equal(orderSubmitSchema.safeParse({ ...validOrder, customer_phone: '08123' }).success, false);
});

test('order schema requires a stable submit token and bounded integer quantity', () => {
  assert.equal(orderSubmitSchema.safeParse({ ...validOrder, submit_token: '' }).success, false);
  assert.equal(orderSubmitSchema.safeParse({ ...validOrder, quantity: 1.5 }).success, false);
  assert.equal(orderSubmitSchema.safeParse({ ...validOrder, quantity: 101 }).success, false);
});

test('online checkout requires a matching AutoLaris channel and no longer requires email', () => {
  const validQris = orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'qris',
    payment_channel: 'QRIS',
  });
  assert.equal(validQris.success, true);
  assert.equal(orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'qris',
    payment_channel: 'VABCA',
  }).success, false);
  assert.equal(orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'bank_transfer',
    payment_channel: 'VABCA',
  }).success, true);
  assert.equal(orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'bank_transfer',
  }).success, false);
  assert.equal(orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'bank_transfer',
    payment_channel: 'DANA',
  }).success, false);
  const locked = orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'bank_transfer',
    payment_channel: 'VABSI',
  });
  assert.equal(locked.success, false);
  assert.equal(
    locked.error?.issues.some((issue) => issue.message === 'Channel pembayaran tidak aktif di provider'),
    true,
  );
});

test('manual transfer requires a selected seller bank account', () => {
  assert.equal(orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'manual_transfer',
    seller_bank_account_id: 7,
  }).success, true);
  assert.equal(orderSubmitSchema.safeParse({
    ...validOrder,
    payment_method: 'manual_transfer',
  }).success, false);
});

test('province aliases enforce COD exclusions consistently', () => {
  const excluded = parseProvinceList('DI Yogyakarta, Kep. Riau');
  assert.equal(isProvinceExcluded('Provinsi Kepulauan Riau', excluded), true);
  assert.equal(isProvinceExcluded('Jawa Timur', excluded), false);
});

test('CRM rendering replaces order variables and produces an encoded WhatsApp URL', () => {
  const message = renderCrmMessage('Halo {{nama}}, order {{inv}} total {{total}}.', {
    customerName: 'Budi',
    customerPhone: '081234567890',
    district: 'Krembangan',
    province: 'Jawa Timur',
    orderNumber: 'INV-1',
    productName: 'Alpha',
    totalAmount: 183000,
    courierCode: 'SiCepat',
  });
  assert.equal(message, 'Halo Budi, order INV-1 total Rp 183.000.');
  assert.equal(buildWaUrl('081234567890', message).startsWith('https://wa.me/6281234567890?text='), true);
});


// T-42 (PR-27): checkout validation results are frozen across the zod 3 → 4
// upgrade. Every expected value below was produced by zod 3.25.76 on the
// schema as it was before the upgrade: the outcome, the parsed data, and
// every issue (field and message) — the routes return the first message to
// the buyer and the headless API returns them all.
const base = { customer_name: "Rina Lestari", customer_phone: "081234567890", address: "Jl. Melati No. 12, Bandung", district: "Sukajadi", province: "Jawa Barat", variant_id: "12", submit_token: "abcdefghijklmnop1234" };
const CASES: Record<string, Record<string, unknown>> = {
  valid_cod: base,
  valid_cod_numbers: { ...base, variant_id: 12, quantity: "3", postal_code: "40161", customer_email: "" },
  valid_qris: { ...base, payment_method: "qris", payment_channel: "QRIS" },
  valid_va: { ...base, payment_method: "bank_transfer", payment_channel: "VABCA" },
  va_unknown_channel: { ...base, payment_method: "bank_transfer", payment_channel: "BCA" },
  valid_manual: { ...base, payment_method: "manual_transfer", seller_bank_account_id: "7" },
  name_short: { ...base, customer_name: "R" },
  name_long: { ...base, customer_name: "x".repeat(101) },
  phone_bad: { ...base, customer_phone: "12345" },
  phone_plus62: { ...base, customer_phone: "+62 812-3456-7890" },
  email_bad: { ...base, customer_email: "bukan-email" },
  address_short: { ...base, address: "pendek" },
  postal_bad: { ...base, postal_code: "123" },
  method_bad: { ...base, payment_method: "crypto" },
  manual_no_account: { ...base, payment_method: "manual_transfer" },
  qris_wrong_channel: { ...base, payment_method: "qris", payment_channel: "BCA" },
  transfer_qris: { ...base, payment_method: "bank_transfer", payment_channel: "QRIS" },
  transfer_no_channel: { ...base, payment_method: "bank_transfer" },
  quantity_zero: { ...base, quantity: 0 },
  quantity_text: { ...base, quantity: "dua" },
  variant_empty: { ...base, variant_id: "  " },
  token_short: { ...base, submit_token: "short" },
  quantity_float: { ...base, quantity: 1.5 },
  account_zero: { ...base, payment_method: "manual_transfer", seller_bank_account_id: 0 },
  variant_object: { ...base, variant_id: {} },
  phone_number_type: { ...base, customer_phone: 81234567890 },
  name_array: { ...base, customer_name: [] },
  quantity_half: { ...base, quantity: 0.5 },
  quantity_over_float: { ...base, quantity: 100.5 },
  account_half: { ...base, payment_method: "manual_transfer", seller_bank_account_id: 0.5 },
  account_negative_float: { ...base, payment_method: "manual_transfer", seller_bank_account_id: -1.5 },
  quantity_infinity: { ...base, quantity: "Infinity" },
  quantity_numeric_string: { ...base, quantity: "7" },
  account_string_float: { ...base, payment_method: "manual_transfer", seller_bank_account_id: "3.5" },
  combo_infinity_transfer: { ...base, quantity: "Infinity", payment_method: "bank_transfer" },
  combo_type_transfer: { ...base, customer_name: 5, payment_method: "bank_transfer" },
  combo_type_manual: { ...base, address: [], payment_method: "manual_transfer" },
  combo_missing_qris: { payment_method: "qris", payment_channel: "VABCA" },
  combo_nan_manual: { ...base, quantity: "dua", payment_method: "manual_transfer" },
  combo_half_transfer: { ...base, quantity: 0.5, payment_method: "bank_transfer" },
  method_null: { ...base, payment_method: null },
  method_number: { ...base, payment_method: 5 },
  channel_null: { ...base, payment_method: "qris", payment_channel: null },
  channel_number: { ...base, payment_method: "bank_transfer", payment_channel: 7 },
  channel_bool: { ...base, payment_method: "bank_transfer", payment_channel: true },
  missing_all: {},
  wrong_types: { customer_name: 5, customer_phone: null, address: [], variant_id: {}, submit_token: true },
};
const ZOD3_RESULTS: Record<string, { ok: true; data: unknown } | { ok: false; issues: Array<{ path: string; message: string }> }> = {
 "valid_cod": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "payment_method": "cod",
   "variant_id": "12",
   "quantity": 1,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "valid_cod_numbers": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "customer_email": "",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "postal_code": "40161",
   "payment_method": "cod",
   "variant_id": "12",
   "quantity": 3,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "valid_qris": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "payment_method": "qris",
   "payment_channel": "QRIS",
   "variant_id": "12",
   "quantity": 1,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "valid_va": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "payment_method": "bank_transfer",
   "payment_channel": "VABCA",
   "variant_id": "12",
   "quantity": 1,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "va_unknown_channel": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Invalid enum value. Expected 'QRIS' | 'VABCA' | 'VAMANDIRI' | 'VABNI' | 'VABRI' | 'VAPERMATA' | 'VABSI' | 'VACIMB' | 'VADANAMON', received 'BCA'"
   }
  ]
 },
 "valid_manual": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "payment_method": "manual_transfer",
   "seller_bank_account_id": 7,
   "variant_id": "12",
   "quantity": 1,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "name_short": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "Nama minimal 2 karakter"
   }
  ]
 },
 "name_long": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "String must contain at most 100 character(s)"
   }
  ]
 },
 "phone_bad": {
  "ok": false,
  "issues": [
   {
    "path": "customer_phone",
    "message": "Nomor WhatsApp / HP tidak valid. Contoh: 081234567890"
   }
  ]
 },
 "phone_plus62": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "payment_method": "cod",
   "variant_id": "12",
   "quantity": 1,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "email_bad": {
  "ok": false,
  "issues": [
   {
    "path": "customer_email",
    "message": "Email pembayaran tidak valid"
   }
  ]
 },
 "address_short": {
  "ok": false,
  "issues": [
   {
    "path": "address",
    "message": "Alamat lengkap minimal 10 karakter"
   }
  ]
 },
 "postal_bad": {
  "ok": false,
  "issues": [
   {
    "path": "postal_code",
    "message": "Kode pos harus 5 digit"
   }
  ]
 },
 "method_bad": {
  "ok": false,
  "issues": [
   {
    "path": "payment_method",
    "message": "Invalid enum value. Expected 'cod' | 'bank_transfer' | 'qris' | 'manual_transfer', received 'crypto'"
   }
  ]
 },
 "manual_no_account": {
  "ok": false,
  "issues": [
   {
    "path": "seller_bank_account_id",
    "message": "Rekening transfer wajib dipilih"
   }
  ]
 },
 "qris_wrong_channel": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Invalid enum value. Expected 'QRIS' | 'VABCA' | 'VAMANDIRI' | 'VABNI' | 'VABRI' | 'VAPERMATA' | 'VABSI' | 'VACIMB' | 'VADANAMON', received 'BCA'"
   }
  ]
 },
 "transfer_qris": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Channel transfer tidak cocok dengan metode pembayaran"
   }
  ]
 },
 "transfer_no_channel": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Channel pembayaran wajib dipilih"
   }
  ]
 },
 "quantity_zero": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Number must be greater than or equal to 1"
   }
  ]
 },
 "quantity_text": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected number, received nan"
   }
  ]
 },
 "variant_empty": {
  "ok": false,
  "issues": [
   {
    "path": "variant_id",
    "message": "Varian produk harus dipilih"
   }
  ]
 },
 "token_short": {
  "ok": false,
  "issues": [
   {
    "path": "submit_token",
    "message": "Token submit tidak valid"
   }
  ]
 },
 "quantity_float": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected integer, received float"
   }
  ]
 },
 "account_zero": {
  "ok": false,
  "issues": [
   {
    "path": "seller_bank_account_id",
    "message": "Number must be greater than 0"
   },
   {
    "path": "seller_bank_account_id",
    "message": "Rekening transfer wajib dipilih"
   }
  ]
 },
 "variant_object": {
  "ok": false,
  "issues": [
   {
    "path": "variant_id",
    "message": "Invalid input"
   }
  ]
 },
 "phone_number_type": {
  "ok": false,
  "issues": [
   {
    "path": "customer_phone",
    "message": "Expected string, received number"
   }
  ]
 },
 "name_array": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "Expected string, received array"
   }
  ]
 },
 "quantity_half": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected integer, received float"
   },
   {
    "path": "quantity",
    "message": "Number must be greater than or equal to 1"
   }
  ]
 },
 "quantity_over_float": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected integer, received float"
   },
   {
    "path": "quantity",
    "message": "Number must be less than or equal to 100"
   }
  ]
 },
 "account_half": {
  "ok": false,
  "issues": [
   {
    "path": "seller_bank_account_id",
    "message": "Expected integer, received float"
   }
  ]
 },
 "account_negative_float": {
  "ok": false,
  "issues": [
   {
    "path": "seller_bank_account_id",
    "message": "Expected integer, received float"
   },
   {
    "path": "seller_bank_account_id",
    "message": "Number must be greater than 0"
   }
  ]
 },
 "quantity_infinity": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected integer, received float"
   },
   {
    "path": "quantity",
    "message": "Number must be less than or equal to 100"
   }
  ]
 },
 "quantity_numeric_string": {
  "ok": true,
  "data": {
   "customer_name": "Rina Lestari",
   "customer_phone": "6281234567890",
   "address": "Jl. Melati No. 12, Bandung",
   "district": "Sukajadi",
   "province": "Jawa Barat",
   "payment_method": "cod",
   "variant_id": "12",
   "quantity": 7,
   "submit_token": "abcdefghijklmnop1234"
  }
 },
 "account_string_float": {
  "ok": false,
  "issues": [
   {
    "path": "seller_bank_account_id",
    "message": "Expected integer, received float"
   }
  ]
 },
 "combo_infinity_transfer": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected integer, received float"
   },
   {
    "path": "quantity",
    "message": "Number must be less than or equal to 100"
   },
   {
    "path": "payment_channel",
    "message": "Channel pembayaran wajib dipilih"
   }
  ]
 },
 "combo_type_transfer": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "Expected string, received number"
   }
  ]
 },
 "combo_type_manual": {
  "ok": false,
  "issues": [
   {
    "path": "address",
    "message": "Expected string, received array"
   }
  ]
 },
 "combo_missing_qris": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "Required"
   },
   {
    "path": "customer_phone",
    "message": "Required"
   },
   {
    "path": "address",
    "message": "Required"
   },
   {
    "path": "district",
    "message": "Required"
   },
   {
    "path": "province",
    "message": "Required"
   },
   {
    "path": "variant_id",
    "message": "Invalid input"
   },
   {
    "path": "submit_token",
    "message": "Required"
   }
  ]
 },
 "combo_nan_manual": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected number, received nan"
   }
  ]
 },
 "combo_half_transfer": {
  "ok": false,
  "issues": [
   {
    "path": "quantity",
    "message": "Expected integer, received float"
   },
   {
    "path": "quantity",
    "message": "Number must be greater than or equal to 1"
   },
   {
    "path": "payment_channel",
    "message": "Channel pembayaran wajib dipilih"
   }
  ]
 },
 "method_null": {
  "ok": false,
  "issues": [
   {
    "path": "payment_method",
    "message": "Expected 'cod' | 'bank_transfer' | 'qris' | 'manual_transfer', received null"
   }
  ]
 },
 "method_number": {
  "ok": false,
  "issues": [
   {
    "path": "payment_method",
    "message": "Expected 'cod' | 'bank_transfer' | 'qris' | 'manual_transfer', received number"
   }
  ]
 },
 "channel_null": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Expected 'QRIS' | 'VABCA' | 'VAMANDIRI' | 'VABNI' | 'VABRI' | 'VAPERMATA' | 'VABSI' | 'VACIMB' | 'VADANAMON', received null"
   }
  ]
 },
 "channel_number": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Expected 'QRIS' | 'VABCA' | 'VAMANDIRI' | 'VABNI' | 'VABRI' | 'VAPERMATA' | 'VABSI' | 'VACIMB' | 'VADANAMON', received number"
   }
  ]
 },
 "channel_bool": {
  "ok": false,
  "issues": [
   {
    "path": "payment_channel",
    "message": "Expected 'QRIS' | 'VABCA' | 'VAMANDIRI' | 'VABNI' | 'VABRI' | 'VAPERMATA' | 'VABSI' | 'VACIMB' | 'VADANAMON', received boolean"
   }
  ]
 },
 "missing_all": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "Required"
   },
   {
    "path": "customer_phone",
    "message": "Required"
   },
   {
    "path": "address",
    "message": "Required"
   },
   {
    "path": "district",
    "message": "Required"
   },
   {
    "path": "province",
    "message": "Required"
   },
   {
    "path": "variant_id",
    "message": "Invalid input"
   },
   {
    "path": "submit_token",
    "message": "Required"
   }
  ]
 },
 "wrong_types": {
  "ok": false,
  "issues": [
   {
    "path": "customer_name",
    "message": "Expected string, received number"
   },
   {
    "path": "customer_phone",
    "message": "Expected string, received null"
   },
   {
    "path": "address",
    "message": "Expected string, received array"
   },
   {
    "path": "district",
    "message": "Required"
   },
   {
    "path": "province",
    "message": "Required"
   },
   {
    "path": "variant_id",
    "message": "Invalid input"
   },
   {
    "path": "submit_token",
    "message": "Expected string, received boolean"
   }
  ]
 }
};

// The one recorded difference (accepted in T-42): zod 3 took a quantity of
// ±Infinity as a number, so its range check and the payment cross-check also
// ran; zod 4 rejects it as a type, which stops both. The outcome (rejected)
// and the first, buyer-facing message are the same; these are the complete
// zod 4 issue lists for those inputs.
const ZOD4_EXCEPTIONS: Record<string, Array<{ path: string; message: string }>> = {
 "quantity_infinity": [
  {
   "path": "quantity",
   "message": "Expected integer, received float"
  }
 ],
 "combo_infinity_transfer": [
  {
   "path": "quantity",
   "message": "Expected integer, received float"
  }
 ]
};

test("T-42: parseOrderSubmit on zod 4 gives every checkout result zod 3 gave", () => {
  for (const [name, input] of Object.entries(CASES)) {
    const expected = ZOD3_RESULTS[name];
    const parsed = parseOrderSubmit(input);
    assert.equal(parsed.success, expected.ok, name);
    if (expected.ok) {
      assert.ok(parsed.success);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), expected.data, name);
    } else {
      assert.ok(!parsed.success);
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      if (Object.hasOwn(ZOD4_EXCEPTIONS, name)) {
        assert.deepEqual(issues, ZOD4_EXCEPTIONS[name], name);
        assert.deepEqual(issues[0], expected.issues[0], `${name}: the buyer-facing message`);
      } else {
        assert.deepEqual(issues, expected.issues, name);
      }
    }
  }
});
