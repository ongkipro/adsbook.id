export const INDONESIAN_MOBILE_PREFIXES = [
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '23',
  '31',
  '32',
  '33',
  '38',
  '51',
  '52',
  '53',
  '55',
  '56',
  '57',
  '58',
  '59',
  '77',
  '78',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '95',
  '96',
  '97',
  '98',
  '99',
] as const;

const INDONESIAN_MOBILE_PREFIX_PATTERN = INDONESIAN_MOBILE_PREFIXES.join('|');

/**
 * One canonical Indonesian mobile number check, applied to the normalized
 * `62`-form (see `normalizePhone`). Format: `62` `8` `<operator><subscriber>`.
 *
 * Length: `62` + 7–12 significant digits = **9–14 digits in 62-form**, which is
 * **8–13 digits in 0-form** (the 0-form is always one shorter, since `0` →
 * `62` adds a character). The 13-digit 0-form is real and current — the old
 * bound of `\d{5,8}` stopped at 12-digit 0-form and rejected live customers at
 * both the browser form and lead capture.
 *
 * The `(prefix)` group is the operator allowlist above: `8` followed by a
 * known two-digit operator code, so every Indonesian carrier is covered while
 * a non-mobile or mistyped prefix is refused.
 */
export const INDONESIAN_WA_REGEX = new RegExp(`^628(${INDONESIAN_MOBILE_PREFIX_PATTERN})\\d{4,9}$`);

export function isValidWa62(value: string) {
  return INDONESIAN_WA_REGEX.test(value);
}

/**
 * Which contact field a checkout form still lacks, judged by the same limits
 * the order endpoints enforce (`order-schema.ts`, `submit-middle-order.ts`).
 * The submit button lights up only when this is null (owner, 2026-11-23:
 * grey until the form is complete), so it never invites a buyer to submit a
 * form the server is certain to refuse. `address: null` for a digital order,
 * which has none.
 */
export const CHECKOUT_NAME_MIN = 2;
export const CHECKOUT_ADDRESS_MIN = 10;
export function missingCheckoutContact(input: {
  name: string;
  phone: string;
  address: string | null;
}): "name" | "phone" | "address" | null {
  if (input.name.trim().length < CHECKOUT_NAME_MIN) return "name";
  if (!isValidWa62(normalizePhone(input.phone))) return "phone";
  if (input.address !== null && input.address.trim().length < CHECKOUT_ADDRESS_MIN) return "address";
  return null;
}

/**
 * The one Indonesian phone normaliser for input, validation, and persistence.
 * `meta-identity.ts` keeps a separate `toE164Digits` on purpose: this one must
 * tolerate a half-typed number so a live input event does not erase what the
 * buyer is still typing, while that one must return nothing rather than hash a
 * number it cannot vouch for.
 */
export function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, '');
  if (!digits) return '';
  // `0062…` is how a phone keyboard writes the international prefix. Without
  // this the leading zero was treated as the local trunk prefix and the number
  // became `620062…`, which the submit schema then rejected — a real customer,
  // typing a real number, told it was invalid.
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('620')) return `62${digits.slice(3)}`;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  if (digits.startsWith('8')) return `62${digits}`;
  if (digits.startsWith('62')) return digits;
  return digits;
}

/**
 * The checkout's field rules and their Indonesian messages, in one place so the
 * COD and digital forms say the same thing (owner, 2026-11-23: the digital
 * form took letters in the WhatsApp field and any text as an email).
 * Empty string = valid. `optional` fields (the digital email) accept "".
 */
export const CHECKOUT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function checkoutFieldMessage(field: "name" | "phone" | "address" | "email", raw: string): string {
  const value = raw.trim();
  if (field === "name") {
    if (!value) return "Maaf, nama Anda belum terisi.";
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s'.-]{2,119}$/.test(value) || !/[A-Za-zÀ-ÿ]{2}/.test(value)) {
      return "Maaf, nama lengkap hanya boleh berisi huruf dan minimal 3 karakter.";
    }
    return "";
  }
  if (field === "phone") {
    if (!value) return "Maaf, nomor WhatsApp Anda belum terisi.";
    if (/[^\d]/.test(value)) return "Maaf, nomor WhatsApp Anda harus berupa angka saja.";
    if (!isValidWa62(normalizePhone(value))) return "Maaf, nomor WhatsApp harus nomor seluler Indonesia yang aktif. Contoh: 081234567890.";
    return "";
  }
  if (field === "address") {
    if (!value) return "Maaf, alamat lengkap Anda belum terisi.";
    if (value.length < 15 || !/[A-Za-zÀ-ÿ]/.test(value) || !/\s/.test(value)) {
      return "Maaf, alamat masih terlalu singkat. Isi jalan/dusun/desa dan patokan jika ada.";
    }
    return "";
  }
  if (!value) return "";
  if (value.length > 160 || !CHECKOUT_EMAIL_PATTERN.test(value)) return "Format email belum benar. Contoh: nama@email.com";
  return "";
}

/** What the WhatsApp field keeps while a buyer types: digits only, 0/8/620 rewritten to 62. */
export function typedWhatsapp(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 15);
  if (!digits) return "";
  if (digits.startsWith("620")) return `62${digits.slice(3)}`;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  if (digits.startsWith("8")) return `62${digits}`;
  return digits;
}
