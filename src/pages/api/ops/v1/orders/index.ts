import type { APIRoute } from "astro";
import { opsError, opsJson, validateOpsRequest } from "../../../../../lib/ops-api";
import { listOpsOrders, OpsQueryError } from "../../../../../lib/ops-order";
import { tenantDatabase } from "../../../../../lib/tenant-database.ts";

export const prerender = false;

/** PRD A45, REQ-254: orders, filtered, cursor-paged, or synced by `updated_since`. */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const access = await validateOpsRequest(request, locals, "ordersList");
  if (!access.allowed) return access.response;
  const database = tenantDatabase(locals);
  if (!database) return access.finalize(opsError("Database order belum tersedia.", 503, "DATABASE_UNAVAILABLE", access.headers));
  try {
    const page = await listOpsOrders(database, url.searchParams, {
      pii: access.key.scopes.includes("ops:orders:read_pii"),
    });
    return access.finalize(opsJson({ success: true, data: page.orders, next_cursor: page.next_cursor }, 200, access.headers));
  } catch (error) {
    if (error instanceof OpsQueryError) {
      return access.finalize(opsError(error.message, error.status, error.code, access.headers));
    }
    console.error("ops-orders-list", error);
    return access.finalize(opsError("Order gagal dimuat.", 500, "INTERNAL", access.headers));
  }
};
