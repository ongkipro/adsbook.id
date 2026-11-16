import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../lib/api.ts";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { cancelStoreRemoval, requestStoreRemoval } from "../../../platform/purge.ts";

export const prerender = false;

/**
 * PRIV-4 (T-26): the owner requests or cancels the store's removal. Owner
 * only — the route is in no other role's list (src/lib/auth.ts).
 */
function context(locals: App.Locals) {
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  return { platformDb, tenantId: locals.tenantContext?.tenantId, actor: locals.admin?.username ?? "owner" };
}

export const GET: APIRoute = async ({ locals }) => {
  const { platformDb, tenantId } = context(locals);
  if (!platformDb || !tenantId) return jsonError("Belum tersedia.", 503);
  const row = await platformDb.prepare("SELECT purge_after FROM tenants WHERE id = ?").bind(tenantId).first<{ purge_after: string | null }>();
  return jsonOk({ data: { purge_after: row?.purge_after ?? null } });
};

export const POST: APIRoute = async ({ locals }) => {
  const { platformDb, tenantId, actor } = context(locals);
  if (!platformDb || !tenantId) return jsonError("Belum tersedia.", 503);
  if (locals.admin?.role !== "owner") return jsonError("Hanya owner yang dapat menghapus toko.", 403);
  const purgeAfter = await requestStoreRemoval(platformDb, tenantId, actor);
  if (!purgeAfter) return jsonError("Permintaan penghapusan sudah tercatat.", 409);
  return jsonOk({ message: "Toko dijadwalkan dihapus. Anda bisa membatalkannya sampai tanggal itu.", data: { purge_after: purgeAfter } });
};

export const DELETE: APIRoute = async ({ locals }) => {
  const { platformDb, tenantId, actor } = context(locals);
  if (!platformDb || !tenantId) return jsonError("Belum tersedia.", 503);
  if (locals.admin?.role !== "owner") return jsonError("Hanya owner yang dapat membatalkan penghapusan.", 403);
  if (!(await cancelStoreRemoval(platformDb, tenantId, actor))) return jsonError("Tidak ada penghapusan yang bisa dibatalkan.", 409);
  return jsonOk({ message: "Penghapusan toko dibatalkan.", data: { purge_after: null } });
};
