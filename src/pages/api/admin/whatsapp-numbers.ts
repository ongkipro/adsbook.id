import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../lib/api";
import {
  addWhatsappNumber,
  listWhatsappNumbers,
  removeWhatsappNumber,
  updateWhatsappNumber,
  WhatsappNumberError,
} from "../../../lib/whatsapp-numbers";
import { tenantDatabase } from "../../../lib/tenant-database.ts";

export const prerender = false;

/**
 * The support WhatsApp numbers /thanks rotates through (PRD A35). Owner and
 * admin only (`ADMIN_API_ROUTES`). Every answer is the full list, so the page
 * never has to guess what a write changed.
 */
function database(locals: App.Locals) {
  const db = tenantDatabase(locals);
  if (!db?.prepare) throw new WhatsappNumberError("Database belum tersedia.", 503);
  return db;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new WhatsappNumberError("Body JSON tidak valid.", 400);
  }
}

function failure(error: unknown, fallback: string) {
  if (error instanceof WhatsappNumberError) return jsonError(error.message, error.status);
  console.error("admin-whatsapp-numbers", error);
  return jsonError(fallback, 500);
}

/** Whether /thanks hands COD buyers to WhatsApp by itself (migration 0060). */
async function readThanksRedirect(db: D1Database) {
  const row = await db.prepare("SELECT thanks_whatsapp_redirect FROM stores ORDER BY id LIMIT 1").first<{ thanks_whatsapp_redirect: number | null }>();
  return Number(row?.thanks_whatsapp_redirect) === 1;
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    const db = database(locals);
    return jsonOk({ data: await listWhatsappNumbers(db), thanks_redirect: await readThanksRedirect(db) });
  } catch (error) {
    return failure(error, "Nomor WhatsApp gagal dimuat.");
  }
};

/**
 * The redirect switch lives beside the numbers it hands buyers to (Paduka,
 * 2026-11-18). It writes this one column only, so it can never overwrite the
 * store profile the Toko & CS page saves.
 */
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    const db = database(locals);
    const body = await readBody(request);
    if (typeof body.thanks_redirect !== "boolean") throw new WhatsappNumberError("Nilai pengalihan tidak valid.", 400);
    await db.prepare("UPDATE stores SET thanks_whatsapp_redirect = ? WHERE id = (SELECT id FROM stores ORDER BY id LIMIT 1)").bind(body.thanks_redirect ? 1 : 0).run();
    return jsonOk({ thanks_redirect: await readThanksRedirect(db) });
  } catch (error) {
    return failure(error, "Pengaturan pengalihan gagal disimpan.");
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const db = database(locals);
    const body = await readBody(request);
    await addWhatsappNumber(db, { label: body.label, phone: body.phone });
    return jsonOk({ data: await listWhatsappNumbers(db) }, 201);
  } catch (error) {
    return failure(error, "Nomor WhatsApp gagal disimpan.");
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  try {
    const db = database(locals);
    const body = await readBody(request);
    await updateWhatsappNumber(db, Number(body.id), {
      label: body.label,
      phone: body.phone,
      is_active: body.is_active === undefined ? undefined : body.is_active === true,
    });
    return jsonOk({ data: await listWhatsappNumbers(db) });
  } catch (error) {
    return failure(error, "Nomor WhatsApp gagal diperbarui.");
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    const db = database(locals);
    const body = await readBody(request);
    await removeWhatsappNumber(db, Number(body.id));
    return jsonOk({ data: await listWhatsappNumbers(db) });
  } catch (error) {
    return failure(error, "Nomor WhatsApp gagal dihapus.");
  }
};
