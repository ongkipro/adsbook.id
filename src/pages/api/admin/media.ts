import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../lib/api";
import { getRuntimeEnv } from "../../../lib/env";
import { tenantR2 } from "../../../platform/keys.ts";
import { checkPlanCap, recordUsage } from "../../../platform/plans.ts";
import { buildStorefrontMediaKey } from "../../../lib/storefront-media";
import { checkStoredVariant, IMAGE_VARIANTS, webpDimensions } from "../../../lib/image-rules.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const tenantId = locals.tenantContext?.tenantId;
  const bucket = tenantId ? tenantR2(getRuntimeEnv(locals), tenantId) : undefined;
  if (!bucket) {
    return jsonError("Penyimpanan media tenant belum tersedia.", 503);
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError("File gambar wajib dipilih.", 400);
    const key = buildStorefrontMediaKey(file);
    // T-37: the plan's hourly media cap, per tenant, spent atomically after
    // validation (buildStorefrontMediaKey above) and before the object is stored.
    const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
    const bytes = await file.arrayBuffer();
    // The same rule as product photos: a WebP the admin made, ≤ 480 px wide.
    const variantCheck = checkStoredVariant("display", file);
    if (!variantCheck.ok) return jsonError(variantCheck.error, 422);
    const dimensions = webpDimensions(new Uint8Array(bytes));
    if (!dimensions) return jsonError("Format gambar harus WebP hasil konversi admin.", 422);
    if (dimensions.width > IMAGE_VARIANTS.display.maxWidth) {
      return jsonError(`Lebar gambar maksimal ${IMAGE_VARIANTS.display.maxWidth} px.`, 422);
    }
    const cap = await checkPlanCap(platformDb, tenantId, "media", true);
    if (!cap.allowed) return jsonError(cap.error, 429);
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        uploadedBy: locals.admin?.username || "unknown",
        originalName: file.name.slice(0, 180),
      },
    });
    if (platformDb && tenantId) {
      await recordUsage(platformDb, tenantId!, { mediaBytes: bytes.byteLength }).catch((error) =>
        console.error("usage-record-failed", { tenant_id: tenantId, error: String(error) }),
      );
    }
    return jsonOk(
      {
        message: "Media tenant berhasil diunggah.",
        data: { key, url: `/media/${key}` },
      },
      201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload media gagal.";
    const status = /Format gambar|File gambar|Ukuran gambar/.test(message) ? 422 : 500;
    if (status === 500) console.error("admin-media-post", error);
    return jsonError(message, status);
  }
};
