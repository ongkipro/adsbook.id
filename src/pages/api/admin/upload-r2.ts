import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../lib/api";
import { getRuntimeEnv } from "../../../lib/env";
import { tenantR2 } from "../../../platform/keys.ts";
import { checkPlanCap, recordUsage } from "../../../platform/plans.ts";
import { LOGO_EDGE, LOGO_MAX_OUTPUT_BYTES } from "../../../lib/store-logo.ts";
import { checkStoredVariant, IMAGE_VARIANTS, jpegDimensions, MAX_UPLOAD_BYTES, webpDimensions } from "../../../lib/image-rules.ts";

export const prerender = false;

/**
 * The store's image upload (src/lib/image-rules.ts, Paduka 2026-11-18). Only a
 * WebP the admin's pipeline made is accepted, checked here against the same
 * table, never trusted from the client:
 * - a store image: WebP, at most 480 px wide, ≤ 300 KB;
 * - its catalog copy (`variant=feed`, `variant_of=<key>`): JPEG, at most
 *   1024 px wide, ≤ 800 KB, stored beside it as `<key>.jpg`, the sibling the
 *   catalog feeds name (Meta takes JPEG or PNG only);
 * - a store logo (`purpose=logo`): a 512 × 512 WebP ≤ 200 KB.
 * The request itself is capped at 2 MB.
 */
const MAX_REQUEST_SIZE = MAX_UPLOAD_BYTES + 64 * 1024;

const BASE_KEY = /^uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.webp$/i;

function isWebp(bytes: Uint8Array) {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // The tenant's own prefix (TEN-3); the returned URL stays tenant-relative.
    const tenantId = locals.tenantContext?.tenantId;
    const bucket = tenantId ? tenantR2(getRuntimeEnv(locals), tenantId) : undefined;
    if (!bucket) {
      return jsonError("Asset storage belum tersedia.", 503);
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_SIZE) {
      return jsonError("Ukuran file maksimal 2 MB.", 413);
    }

    const formData = await request.formData();
    const purpose = String(formData.get("purpose") || "");
    // The catalog copy rides along with the photo it belongs to and has its own
    // allowance of the plan cap (T-37), so it never eats the seller's uploads.
    const variantOf = String(formData.get("variant_of") || "").trim();
    const isFeed = String(formData.get("variant") || "") === "feed" && variantOf !== "";
    const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
    const capName = isFeed ? "media-derivative" : "media";
    const fileInput = formData.get("file");
    const file = fileInput instanceof File ? fileInput : null;

    if (!file) {
      return jsonError("File gambar wajib dipilih.", 400);
    }
    if (file.size <= 0) {
      return jsonError("File upload tidak boleh kosong.", 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return jsonError("Ukuran file maksimal 2 MB.", 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const variant = isFeed ? "feed" : "display";
    // Read from the bytes, never the client's word: a feed copy is a JPEG, every other upload a WebP.
    const dimensions = isFeed
      ? (file.type === "image/jpeg" ? jpegDimensions(bytes) : null)
      : (file.type === "image/webp" && isWebp(bytes) ? webpDimensions(bytes) : null);
    if (!dimensions) return jsonError("Gambar harus diolah oleh admin sebelum diunggah.", 415);

    if (purpose === "logo") {
      if (file.size > LOGO_MAX_OUTPUT_BYTES || dimensions.width !== LOGO_EDGE || dimensions.height !== LOGO_EDGE) {
        return jsonError("Logo harus WebP 512 × 512 px maksimal 200 KB. Unggah ulang dari Pengaturan › Toko.", 413);
      }
    } else {
      const check = checkStoredVariant(variant, file);
      if (!check.ok) return jsonError(check.error, 413);
      if (dimensions.width > IMAGE_VARIANTS[variant].maxWidth) {
        return jsonError(`Lebar gambar maksimal ${IMAGE_VARIANTS[variant].maxWidth} px.`, 413);
      }
    }

    // The catalog copy is stored beside the photo it belongs to; its parent key
    // is echoed back by the caller, so it must match the shape this route makes.
    let fileName: string;
    if (isFeed) {
      if (!BASE_KEY.test(variantOf)) {
        return jsonError("Kunci gambar induk tidak valid.", 400);
      }
      fileName = variantOf.replace(/\.webp$/i, ".jpg");
    } else {
      fileName = `uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.webp`;
    }
    // Spent atomically here, after every validation and before the object is
    // stored: a refused file costs nothing, and concurrent uploads cannot all
    // pass a peek and store past the cap.
    const spent = await checkPlanCap(platformDb, tenantId, capName, true);
    if (!spent.allowed) return jsonError(spent.error, 429);
    await bucket.put(fileName, bytes, {
      httpMetadata: {
        contentType: purpose === "logo" ? "image/webp" : IMAGE_VARIANTS[variant].type,
        cacheControl: "public, max-age=31536000, immutable",
        contentDisposition: "inline",
      },
    });
    if (platformDb && tenantId) {
      await recordUsage(platformDb, tenantId, { mediaBytes: bytes.byteLength }).catch((error) =>
        console.error("usage-record-failed", { tenant_id: tenantId, error: String(error) }),
      );
    }
    return jsonOk({
      url: `/assets/${fileName}`,
      fileName,
      width: dimensions.width,
      height: dimensions.height,
    });
  } catch (error) {
    console.error("admin-upload-r2-post", error);
    return jsonError("Gagal mengunggah berkas.", 500);
  }
};
