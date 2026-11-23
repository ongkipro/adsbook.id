import assert from "node:assert/strict";
import test from "node:test";
import { orderSubmitSchema } from "./order-schema.ts";
import {
  CHECKOUT_ADDRESS_MIN,
  CHECKOUT_NAME_MIN,
  missingCheckoutContact,
  isValidWa62,
  normalizePhone,
} from "./validation.ts";
import { toE164Digits } from "./meta-identity.ts";

const ORDER = {
  customer_name: "Budi Santoso",
  address: "Jalan Testing Nomor 10 RT 01",
  district: "Bandung Wetan",
  province: "Jawa Barat",
  variant_id: "1",
  submit_token: "0123456789abcdef0123",
};

test("every way a buyer writes their number lands on the same stored value", () => {
  for (const typed of [
    "081234567890",
    "+62 812-3456-7890",
    "8123456789 ",
    "62081234567890",
    // The international prefix a phone keyboard produces. This used to become
    // `620062…` and the buyer was told a valid number was invalid.
    "006281234567890",
  ]) {
    const parsed = orderSubmitSchema.safeParse({ ...ORDER, customer_phone: typed });
    assert.ok(parsed.success, `checkout rejected ${typed}`);
    assert.match(parsed.data.customer_phone, /^628\d{8,11}$/);
  }
});

test("a stored number hashes to itself, so both Meta legs describe one person", () => {
  // The order row holds `normalizePhone` output and the Pixel/CAPI legs hash it
  // through `toE164Digits`. If the two disagreed the fix in `meta-identity.ts`
  // would be undone at the database boundary instead of in the tracker.
  for (const typed of ["081234567890", "+62 812-3456-7890", "8123456789"]) {
    const stored = normalizePhone(typed);
    assert.equal(toE164Digits(stored), stored);
  }
});

test("an unusable number is refused at the trust boundary, not repaired", () => {
  for (const typed of ["0812", "", "abcdefgh", "1234567890123456789"]) {
    assert.equal(
      orderSubmitSchema.safeParse({ ...ORDER, customer_phone: typed }).success,
      false,
      `checkout accepted ${typed}`,
    );
  }
});

test("a 13-digit 0-form number is accepted — the real, current length", () => {
  // The bug: real Indonesian mobiles reach 13 digits in 0-form (14 in 62-form),
  // and the old bound stopped one digit short, rejecting live customers.
  const raw = "0812345678901"; // 13 digits
  const normalized = normalizePhone(raw); // -> 62812345678901 (14)
  assert.equal(normalized, "62812345678901");
  assert.equal(isValidWa62(normalized), true);
  assert.equal(
    orderSubmitSchema.safeParse({ ...ORDER, customer_phone: raw }).success,
    true,
  );
});

test("the accepted length is 0-form 8-13 / 62-form 9-14, inclusive", () => {
  const zeros = (n: number) => "12".padEnd(n - 2, "0"); // operator 12 then filler
  // 0-form boundaries (operator 12 is valid).
  assert.equal(isValidWa62(normalizePhone("0812" + "3456")), true); // 8-digit 0-form
  assert.equal(isValidWa62(normalizePhone("0812345")), false); // 7-digit — too short
  assert.equal(isValidWa62(normalizePhone("0812345678901")), true); // 13-digit
  assert.equal(isValidWa62(normalizePhone("081234567890123")), false); // 15-digit — too long
  void zeros;
});

test("every Indonesian operator family is accepted, a non-mobile prefix is not", () => {
  for (const sample of [
    "081312345678", // Telkomsel
    "085612345678", // Indosat
    "081712345678", // XL
    "083812345678", // Axis
    "089512345678", // Three
    "088112345678", // Smartfren
  ]) {
    assert.equal(isValidWa62(normalizePhone(sample)), true, `rejected ${sample}`);
  }
  // Landline/invalid operator codes after 8 are refused.
  assert.equal(isValidWa62(normalizePhone("080012345678")), false);
  assert.equal(isValidWa62(normalizePhone("089012345678")), false);
});

test("checkout, lead capture, and admin edit share one rule", () => {
  const raw = "0851 2345 6789 0"; // 13-digit 0-form, Telkomsel byU
  const normalized = normalizePhone(raw);
  // The canonical predicate the admin route and the browser forms both call.
  assert.equal(isValidWa62(normalized), true);
  // The checkout schema, which normalizes then refines with the same predicate.
  assert.equal(
    orderSubmitSchema.safeParse({ ...ORDER, customer_phone: raw }).success,
    true,
  );
});

test("the order endpoint refuses a one-letter name and a short address, and accepts the minimum", () => {
  // The submit button no longer pre-judges the form (owner, 2026-11-23: it
  // always reads "Pesan Sekarang"); the schema is the one gate.
  const order = {
    customer_phone: "081234567890", district: "Coblong", province: "Jawa Barat", variant_id: "1", submit_token: "t".repeat(16),
  };
  assert.equal(orderSubmitSchema.safeParse({ ...order, customer_name: "A", address: "Jl. Dago No. 12, Coblong" }).success, false);
  assert.equal(orderSubmitSchema.safeParse({ ...order, customer_name: "Al", address: "x".repeat(9) }).success, false);
  assert.equal(orderSubmitSchema.safeParse({ ...order, customer_name: "Al", address: "x".repeat(10) }).success, true);
});

test("the checkout button lights up exactly when the order endpoint will accept the contact", () => {
  const ready = { name: "Siti", phone: "081234567890", address: "Jl. Dago No. 12, Coblong" };
  assert.equal(missingCheckoutContact(ready), null);
  assert.equal(missingCheckoutContact({ ...ready, phone: "0812345" }), "phone", "half-typed");
  assert.equal(missingCheckoutContact({ ...ready, phone: "0812-3456-7890" }), null);
  assert.equal(missingCheckoutContact({ ...ready, phone: "0212345678" }), "phone", "landline");
  assert.equal(missingCheckoutContact({ ...ready, name: "A" }), "name");
  assert.equal(missingCheckoutContact({ ...ready, address: "Jl. Dago" }), "address");
  assert.equal(missingCheckoutContact({ ...ready, address: null }), null, "a digital order has no address");
  assert.equal(CHECKOUT_NAME_MIN, 2);
  assert.equal(CHECKOUT_ADDRESS_MIN, 10);
});

test("checkout field rules: one set of messages for the COD and digital forms", async () => {
  const { checkoutFieldMessage, typedWhatsapp } = await import("./validation.ts");
  // WhatsApp: digits only, an Indonesian mobile, any common way of typing it.
  assert.equal(typedWhatsapp("0812-3456-7890"), "6281234567890");
  assert.equal(typedWhatsapp("+62 812 3456 7890"), "6281234567890");
  assert.equal(typedWhatsapp("812abc34"), "6281234", "letters never stay in the field");
  assert.equal(typedWhatsapp("abc"), "");
  assert.equal(typedWhatsapp("6208123456789"), "628123456789");
  assert.equal(checkoutFieldMessage("phone", ""), "Maaf, nomor WhatsApp Anda belum terisi.");
  assert.equal(checkoutFieldMessage("phone", "08123abc"), "Maaf, nomor WhatsApp Anda harus berupa angka saja.");
  assert.match(checkoutFieldMessage("phone", "0212345678"), /nomor seluler Indonesia/, "a landline is refused");
  assert.match(checkoutFieldMessage("phone", "6281234"), /nomor seluler Indonesia/, "too short");
  assert.equal(checkoutFieldMessage("phone", "6281234567890"), "");
  // Email: optional on a digital order, but when given it must be an address.
  assert.equal(checkoutFieldMessage("email", ""), "");
  for (const bad of ["budi", "budi@", "budi@gmail", "@gmail.com", "budi @gmail.com", "budi@gmail.c", `${"a".repeat(160)}@x.com`]) {
    assert.match(checkoutFieldMessage("email", bad), /Format email belum benar/, bad);
  }
  assert.equal(checkoutFieldMessage("email", "budi.santoso+toko@gmail.co.id"), "");
  // Name and address keep the COD form's limits.
  assert.match(checkoutFieldMessage("name", "A"), /minimal 3 karakter/);
  assert.match(checkoutFieldMessage("name", "Budi123"), /hanya boleh berisi huruf/);
  assert.equal(checkoutFieldMessage("name", "Siti Aminah"), "");
  assert.match(checkoutFieldMessage("address", "Jl. Dago"), /terlalu singkat/);
  assert.equal(checkoutFieldMessage("address", "Jl. Dago No. 12, Coblong"), "");
});

test("a valid checkout email on the browser is a valid email on the server", async () => {
  const { checkoutFieldMessage } = await import("./validation.ts");
  const { orderSubmitSchema } = await import("./order-schema.ts");
  const base = { customer_name: "Siti", customer_phone: "081234567890", address: "Jl. Dago No. 12, Coblong", district: "Coblong", province: "Jawa Barat", variant_id: "1", submit_token: "t".repeat(16) };
  for (const email of ["budi@gmail.com", "budi.santoso+toko@gmail.co.id", "x@y.io"]) {
    assert.equal(checkoutFieldMessage("email", email), "", email);
    assert.equal(orderSubmitSchema.safeParse({ ...base, customer_email: email }).success, true, `server accepts ${email}`);
  }
});
