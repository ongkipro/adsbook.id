/**
 * The admin's image pipeline (browser side). Every upload path calls
 * `processImageUpload`; the rules live in src/lib/image-rules.ts and the
 * server re-checks them.
 *
 * In: JPG, PNG or WebP up to 2 MB. Out: a WebP at most 480 px wide (height
 * follows the source, never upscaled) for the store, and, for a product photo,
 * a JPEG at most 1024 px wide for the Meta and Google catalog feeds.
 *
 * Existing files in R2 are left alone; the rule governs uploads from here on.
 */
import { checkUploadSource, fitWidth, IMAGE_QUALITIES, IMAGE_VARIANTS, type ImageVariant } from "./image-rules.ts";

/** Re-exported for callers that only need the limit. */
export { MAX_UPLOAD_BYTES } from "./image-rules.ts";

async function encodeVariant(bitmap: ImageBitmap, variant: ImageVariant, name: string): Promise<File> {
  const rule = IMAGE_VARIANTS[variant];
  const size = fitWidth(bitmap.width, bitmap.height, rule.maxWidth);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Browser ini tidak bisa mengolah gambar.");
  if (rule.type === "image/jpeg") {
    // JPEG has no transparency: a transparent PNG would turn black. White, like a packshot.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  const extension = rule.type === "image/webp" ? "webp" : "jpg";
  for (const quality of IMAGE_QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, rule.type, quality));
    // A browser that cannot encode WebP from a canvas hands back PNG instead of failing.
    if (!blob || blob.type !== rule.type) {
      throw new Error("Browser ini tidak bisa mengonversi gambar. Gunakan Chrome, Edge, atau Firefox terbaru.");
    }
    if (blob.size <= rule.maxBytes) return new File([blob], `${name}.${extension}`, { type: rule.type });
  }
  throw new Error("Gambar terlalu detail untuk dikompres. Coba foto dengan latar yang lebih polos.");
}

export type ProcessedImage = { display: File; feed: File | null; width: number; height: number };

/**
 * Check, scale and encode one picked file. `feed: true` (product photos) also
 * makes the catalog copy. Rejects with a message meant for the seller.
 */
export async function processImageUpload(file: File, options: { feed?: boolean } = {}): Promise<ProcessedImage> {
  const check = checkUploadSource(file);
  if (!check.ok) throw new Error(check.error);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("File gambar tidak dapat dibaca.");
  });
  try {
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    const display = await encodeVariant(bitmap, "display", base);
    const feed = options.feed ? await encodeVariant(bitmap, "feed", base) : null;
    const size = fitWidth(bitmap.width, bitmap.height, IMAGE_VARIANTS.display.maxWidth);
    return { display, feed, width: size.width, height: size.height };
  } finally {
    bitmap.close();
  }
}

/**
 * Upload a processed image to the store's R2 (`/api/admin/upload-r2`), then
 * its catalog copy beside it. Resolves the stored URL and whether the feed
 * copy was stored; a missing feed copy is reported, never fatal: the feed
 * then names the 480 px photo.
 */
export async function uploadProcessedImage(image: ProcessedImage): Promise<{ url: string; fileName: string; feedStored: boolean }> {
  const form = new FormData();
  form.set("file", image.display);
  const response = await fetch("/api/admin/upload-r2", { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success || !payload.url) throw new Error(payload.error || "Gambar gagal diunggah.");
  let feedStored = false;
  if (image.feed) {
    const feedForm = new FormData();
    feedForm.set("file", image.feed);
    feedForm.set("variant_of", String(payload.fileName || ""));
    feedForm.set("variant", "feed");
    const feedResponse = await fetch("/api/admin/upload-r2", { method: "POST", body: feedForm }).catch(() => null);
    feedStored = Boolean(feedResponse?.ok);
  }
  return { url: String(payload.url), fileName: String(payload.fileName || ""), feedStored };
}
