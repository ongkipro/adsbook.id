/**
 * A store's logo (Pengaturan › Toko & CS, Paduka 2026-11-17): one square WebP.
 *
 * Rules, enforced in the browser before upload and re-checked by the server:
 * - in: JPG, PNG or WebP, at most 5 MB, shortest edge at least 256 px;
 * - out: 512 × 512 WebP. A logo that is not square is never cropped (a wide
 *   wordmark would lose letters); it is scaled to fit and centred on a
 *   transparent square, so the result is always 1:1;
 * - at most 200 KB after encoding (quality steps down until it fits).
 *
 * 512 px covers every place the logo is drawn: the admin tile (36 CSS px), the
 * storefront header (32 px high), the tab and home-screen icon (192 px) and the
 * Organization logo in JSON-LD (Google asks for at least 112 × 112).
 */
export const LOGO_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const LOGO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const LOGO_MIN_EDGE = 256;
export const LOGO_EDGE = 512;
export const LOGO_MAX_OUTPUT_BYTES = 200 * 1024;
export const LOGO_QUALITIES = [0.9, 0.82, 0.74, 0.66] as const;

export type LogoCheck = { ok: true } | { ok: false; error: string };

/** The source file before any decoding: type and weight. */
export function checkLogoFile(file: { type: string; size: number }): LogoCheck {
  if (!(LOGO_INPUT_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Logo harus berupa file JPG, PNG, atau WebP." };
  }
  if (file.size > LOGO_MAX_INPUT_BYTES) {
    return { ok: false, error: "Ukuran file logo maksimal 5 MB." };
  }
  return { ok: true };
}

/** The decoded image: big enough to stay sharp at 512 px? */
export function checkLogoDimensions(width: number, height: number): LogoCheck {
  if (!(width > 0 && height > 0)) return { ok: false, error: "File logo tidak dapat dibaca." };
  if (Math.min(width, height) < LOGO_MIN_EDGE) {
    return { ok: false, error: `Logo terlalu kecil (${width} × ${height} px). Minimal ${LOGO_MIN_EDGE} × ${LOGO_MIN_EDGE} px.` };
  }
  return { ok: true };
}

/** Where the source is drawn inside the square: fit (contain) and centre, never crop. */
export function fitInSquare(width: number, height: number, edge: number = LOGO_EDGE) {
  const scale = edge / Math.max(width, height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return { x: Math.round((edge - w) / 2), y: Math.round((edge - h) / 2), width: w, height: h };
}

/**
 * What a saved logo value may be: empty (no logo), the store's own upload
 * (`/assets/uploads/...`), another same-site path, or an https URL. Never a
 * protocol-relative or script URL: the value lands in `<img src>` and `<link
 * rel="icon">` on every page of the store.
 */
export function isAllowedLogoUrl(value: string): boolean {
  if (value === "") return true;
  if (value.length > 300 || /[\s"'<>\\]/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Browser-only: decode, fit into a transparent 512 px square, encode WebP under
 * 200 KB. Resolves the File to upload, or rejects with a message for the seller.
 */
export async function prepareStoreLogo(file: File): Promise<File> {
  const fileCheck = checkLogoFile(file);
  if (!fileCheck.ok) throw new Error(fileCheck.error);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("File logo tidak dapat dibaca.");
  });
  try {
    const sizeCheck = checkLogoDimensions(bitmap.width, bitmap.height);
    if (!sizeCheck.ok) throw new Error(sizeCheck.error);
    const canvas = document.createElement("canvas");
    canvas.width = LOGO_EDGE;
    canvas.height = LOGO_EDGE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Browser ini tidak bisa mengolah gambar.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const box = fitInSquare(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, box.x, box.y, box.width, box.height);
    for (const quality of LOGO_QUALITIES) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (!blob || blob.type !== "image/webp") {
        throw new Error("Browser ini tidak bisa membuat WebP. Gunakan Chrome, Edge, atau Firefox terbaru.");
      }
      if (blob.size <= LOGO_MAX_OUTPUT_BYTES) return new File([blob], "logo.webp", { type: "image/webp" });
    }
    throw new Error("Logo terlalu rumit untuk dikompres di bawah 200 KB. Coba file yang lebih sederhana.");
  } finally {
    bitmap.close();
  }
}
