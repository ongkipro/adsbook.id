import type { APIRoute } from "astro";
import { opsError, opsJson, validateOpsRequest } from "../../../../../lib/ops-api";
import { readOpsOrder } from "../../../../../lib/ops-order";
import { tenantDatabase } from "../../../../../lib/tenant-database.ts";

export const prerender = false;

/** PRD A45, REQ-255: one order by its number, with items and payment. */
export const GET: APIRoute = async ({ request, params, locals }) => {
  const access = await validateOpsRequest(request, locals, "orderDetail");
  if (!access.allowed) return access.response;
  const database = tenantDatabase(locals);
  if (!database) return access.finalize(opsError("Database order belum tersedia.", 503, "DATABASE_UNAVAILABLE", access.headers));
  try {
    const order = await readOpsOrder(database, String(params.number || ""), {
      pii: access.key.scopes.includes("ops:orders:read_pii"),
    });
    return access.finalize(
      order
        ? opsJson({ success: true, data: order }, 200, access.headers)
        : opsError("Order tidak ditemukan.", 404, "ORDER_NOT_FOUND", access.headers),
    );
  } catch (error) {
    console.error("ops-order-detail", error);
    return access.finalize(opsError("Order gagal dimuat.", 500, "INTERNAL", access.headers));
  }
};
