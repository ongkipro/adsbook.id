import { z } from 'zod';
import {
  AUTOLARIS_CHECKOUT_CHANNELS,
  autoLarisChannelLockReason,
} from './autolaris-client.ts';

import { isValidWa62, normalizePhone } from './validation.ts';
export const normalizePhoneNumber = normalizePhone;

// zod 4's `.int()` stops the checks after it; zod 3 went on to the range
// checks too (`0.5` failed both). A non-aborting refinement with zod 3's
// wording keeps every issue zod 3 reported (T-42).
const ZOD3_INT = "Expected integer, received float";

export const orderSubmitSchema = z.object({
  customer_name: z.string().min(2, 'Nama minimal 2 karakter').max(100),
  // Normalize first, then run the one canonical operator+length check, so
  // checkout, the browser forms, lead capture and admin edits all agree.
  customer_phone: z.string().transform(normalizePhone).pipe(
    z.string().refine(isValidWa62, {
      message: 'Nomor WhatsApp / HP tidak valid. Contoh: 081234567890',
    }),
  ),
  customer_email: z.string().trim().pipe(z.email('Email pembayaran tidak valid').max(160)).optional().or(z.literal('')),
  address: z.string().trim().min(10, 'Alamat lengkap minimal 10 karakter').max(500),
  district: z.string().trim().min(2, 'Kecamatan harus diisi').max(120),
  province: z.string().trim().min(2, 'Provinsi harus diisi').max(120),
  postal_code: z.string().trim().regex(/^\d{5}$/, 'Kode pos harus 5 digit').optional().or(z.literal('')),
  payment_method: z.enum(['cod', 'bank_transfer', 'qris', 'manual_transfer']).default('cod'),
  payment_channel: z.enum(AUTOLARIS_CHECKOUT_CHANNELS).optional(),
  seller_bank_account_id: z.coerce.number().refine(Number.isInteger, ZOD3_INT).positive().optional(),
  variant_id: z.union([z.string(), z.number().transform(String)]).pipe(
    z.string().trim().min(1, 'Varian produk harus dipilih').max(120),
  ),
  quantity: z.coerce.number().refine(Number.isInteger, ZOD3_INT).min(1).max(100).default(1),
  submit_token: z.string().trim().min(16, 'Token submit tidak valid').max(120),
  website: z.string().optional(), // Honeypot field
}).superRefine((input, context) => {
  if (input.payment_method === 'cod') return;
  if (input.payment_method === 'manual_transfer') {
    if (!input.seller_bank_account_id) {
      context.addIssue({
        code: "custom",
        path: ['seller_bank_account_id'],
        message: 'Rekening transfer wajib dipilih',
      });
    }
    return;
  }
  if (!input.payment_channel) {
    context.addIssue({
      code: "custom",
      path: ['payment_channel'],
      message: 'Channel pembayaran wajib dipilih',
    });
  } else if (autoLarisChannelLockReason(input.payment_channel)) {
    context.addIssue({
      code: "custom",
      path: ['payment_channel'],
      message: 'Channel pembayaran tidak aktif di provider',
    });
  }
  if (input.payment_method === 'qris' && input.payment_channel !== 'QRIS') {
    context.addIssue({
      code: "custom",
      path: ['payment_channel'],
      message: 'Channel QRIS tidak cocok dengan metode pembayaran',
    });
  }
  if (input.payment_method === 'bank_transfer' && input.payment_channel === 'QRIS') {
    context.addIssue({
      code: "custom",
      path: ['payment_channel'],
      message: 'Channel transfer tidak cocok dengan metode pembayaran',
    });
  }
});

export type OrderSubmitInput = z.infer<typeof orderSubmitSchema>;

/** zod 3's name for a value's type, as its default messages used it. */
function zod3TypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "nan";
  if (value instanceof Date) return "date";
  return typeof value;
}

/**
 * zod 3's default wording for the issues this schema can raise without a
 * message of its own (T-42). The checkout routes return the first message to
 * the buyer, so the zod 4 upgrade keeps these words; a message the schema
 * writes itself always wins over this map.
 */
function zod3Message(issue: z.core.$ZodRawIssue): string | undefined {
  const input = (issue as { input?: unknown }).input;
  switch (issue.code) {
    case "invalid_type":
      if (input === undefined) return "Required";
      if (issue.expected === "int") return "Expected integer, received float";
      // zod 3 took ±Infinity as a number and failed it as a non-integer; zod 4
      // fails the type itself. Same first message (the one buyers see); zod 3's
      // follow-up range issue for it is the one result not kept.
      if (issue.expected === "number" && typeof input === "number" && !Number.isFinite(input) && !Number.isNaN(input)) return "Expected integer, received float";
      return `Expected ${issue.expected}, received ${zod3TypeName(input)}`;
    case "too_small":
      if (issue.origin === "string") return `String must contain at least ${issue.minimum} character(s)`;
      if (issue.origin === "number") return `Number must be greater than${issue.inclusive ? " or equal to" : ""} ${issue.minimum}`;
      return undefined;
    case "too_big":
      if (issue.origin === "string") return `String must contain at most ${issue.maximum} character(s)`;
      if (issue.origin === "number") return `Number must be less than${issue.inclusive ? " or equal to" : ""} ${issue.maximum}`;
      return undefined;
    case "invalid_value": {
      const expected = issue.values.map((value) => `'${String(value)}'`).join(" | ");
      // zod 3 told a wrong type apart from a wrong value.
      return typeof input === "string"
        ? `Invalid enum value. Expected ${expected}, received '${input}'`
        : `Expected ${expected}, received ${zod3TypeName(input)}`;
    }
    case "invalid_union":
      return "Invalid input";
    default:
      return undefined;
  }
}

/**
 * Parse a checkout submission with zod 3's results (T-42): its wording, and
 * no further issue on a field after its type check failed — zod 4 keeps
 * checking (an array `address` also fails `.min(10)`), zod 3 stopped there.
 */
export function parseOrderSubmit(input: unknown) {
  const parsed = orderSubmitSchema.safeParse(input, { error: zod3Message });
  if (parsed.success) return parsed;
  const typeFailed = new Set<string>();
  const issues = parsed.error.issues.filter((issue) => {
    const key = issue.path.join(".");
    if (typeFailed.has(key)) return false;
    if (issue.code === "invalid_type") typeFailed.add(key);
    return true;
  });
  return { success: false as const, error: new z.ZodError(issues) as z.ZodError<OrderSubmitInput> };
}
