import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../lib/api";
import { tenantDatabase } from "../../../../lib/tenant-database.ts";
import { PRIVACY_EXTRA_MAX } from "../../../../platform/legal.ts";

export const prerender = false;

// T-39 (PR-24): the seller's own section of the storefront privacy notice.
// Owner and admin (ADMIN_PAGE_ROUTES). Provider lines are never editable here.
export const GET: APIRoute = async ({ locals }) => {
  const database = tenantDatabase(locals);
  if (!database) return jsonError("Database toko belum tersedia.", 503);
  const row = await database.prepare("SELECT privacy_notice_extra FROM stores ORDER BY id LIMIT 1").first<{ privacy_notice_extra: string | null }>();
  return jsonOk({ extra: row?.privacy_notice_extra ?? "" });
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const database = tenantDatabase(locals);
  if (!database) return jsonError("Database toko belum tersedia.", 503);
  const body = (await request.json().catch(() => null)) as { extra?: unknown } | null;
  if (!body || typeof body.extra !== "string") return jsonError("Teks tambahan wajib berupa teks.", 400);
  const extra = body.extra.replace(/\r\n?/g, "\n").trim();
  if (extra.length > PRIVACY_EXTRA_MAX) return jsonError(`Maksimal ${PRIVACY_EXTRA_MAX} karakter.`, 400);
  await database.prepare("UPDATE stores SET privacy_notice_extra = ? WHERE id = (SELECT id FROM stores ORDER BY id LIMIT 1)").bind(extra || null).run();
  return jsonOk({ extra });
};
