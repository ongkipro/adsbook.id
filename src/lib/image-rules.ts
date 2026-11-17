/**
 * Every image an admin uploads, in one table (Paduka, 2026-11-18: "max 2mb
 * keseluruhan … convert auto to webp … width max 480px karena kita pakai
 * sistem compact … tinggi auto … proses foto di lakukan oleh sistem kita").
 *
 * The browser does the work (src/lib/client-image.ts): decode, scale so the
 * width is at most the variant's limit (height follows the source's aspect;
 * never upscaled), encode, step quality down until the file fits. The server
 * (src/pages/api/admin/upload-r2.ts) re-checks type, width and bytes against
 * this table and refuses anything the pipeline did not make.
 *
 * - `display`: WebP, at most 480 px wide. The storefront is one 480 CSS px
 *   column (compact-market); catalogue cards (~182 CSS px) use it too.
 * - `feed`: JPEG, at most 1024 px wide, product photos only, stored beside
 *   the display copy as `<key>.jpg` — the sibling the catalog feeds already
 *   name (`feedImagePath`). Meta catalogs take JPEG or PNG only and require
 *   at least 500 × 500 px (1024 × 1024 recommended); Google Merchant requires
 *   500 × 500 from 2027-01-31.
 *
 * The store logo (src/lib/store-logo.ts) is a 512 px WebP square: it is drawn
 * as a tab and home-screen icon and must be square.
 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ImageVariant = "display" | "feed";

export const IMAGE_VARIANTS: Record<ImageVariant, { maxWidth: number; maxBytes: number; type: "image/webp" | "image/jpeg" }> = {
  display: { maxWidth: 480, maxBytes: 300 * 1024, type: "image/webp" },
  feed: { maxWidth: 1024, maxBytes: 800 * 1024, type: "image/jpeg" },
};

/** Quality steps the encoder walks down until the file is within its budget. */
export const IMAGE_QUALITIES = [0.82, 0.74, 0.66, 0.58] as const;

/** A product photo smaller than this cannot make a catalog-sized feed copy. */
export const FEED_MIN_WIDTH = 500;

export type UploadCheck = { ok: true } | { ok: false; error: string };

/** The source the seller picked: JPG, PNG or WebP, at most 2 MB. */
export function checkUploadSource(file: { type: string; size: number }): UploadCheck {
  if (!(UPLOAD_INPUT_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Gambar harus berupa file JPG, PNG, atau WebP." };
  }
  if (!(file.size > 0)) return { ok: false, error: "File gambar kosong." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "Ukuran file maksimal 2 MB." };
  return { ok: true };
}

/**
 * The size a variant is drawn at: the width is capped, the height follows the
 * source (auto), and nothing is ever scaled up.
 */
export function fitWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxWidth / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** What the server accepts for one stored variant: its type, within its byte budget. */
export function checkStoredVariant(variant: ImageVariant, file: { type: string; size: number }): UploadCheck {
  const rule = IMAGE_VARIANTS[variant];
  if (file.type !== rule.type) return { ok: false, error: "Gambar harus diolah oleh admin sebelum diunggah." };
  if (!(file.size > 0)) return { ok: false, error: "File gambar kosong." };
  if (file.size > rule.maxBytes) {
    return { ok: false, error: `Gambar hasil konversi terlalu besar (maksimal ${Math.round(rule.maxBytes / 1024)} KB).` };
  }
  return { ok: true };
}

/**
 * Width and height of a WebP from its header (VP8, VP8L, VP8X), for the
 * server-side check. Null when the bytes are not a readable WebP.
 */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
  const chunk = ascii(12, 4);
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes) then the 0x9d 0x01 0x2a start code, then 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  return null;
}

/** Width and height of a baseline or progressive JPEG from its SOF marker. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

