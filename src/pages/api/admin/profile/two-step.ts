import type { APIRoute } from "astro";
import { getAdminCredential } from "../../../../lib/admin-credentials.ts";
import { jsonError, jsonOk } from "../../../../lib/api.ts";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "../../../../lib/auth.ts";
import {
  beginEnrollment,
  confirmEnrollment,
  disableOwnTwoStep,
  recoveryCodesLeft,
  twoStepEnabled,
} from "../../../../lib/seller-two-step.ts";
import { tenantDatabase } from "../../../../lib/tenant-database.ts";

export const prerender = false;

/**
 * T-57 / PR-35: the signed-in user's own two-step verification, from
 * /admin/profile. Every role manages its own; every change needs the current
 * password (and turning it off, a current code too). Nobody manages another
 * user's here: an owner turns a staff member's off from Akses Pengguna.
 */
async function self(locals: App.Locals) {
  const database = tenantDatabase(locals);
  if (!database || !locals.admin) return null;
  const credential = await getAdminCredential(database, locals.admin.username);
  return credential ? { database, credential } : null;
}

export const GET: APIRoute = async ({ locals }) => {
  const me = await self(locals);
  if (!me) return jsonError("Akun tidak ditemukan.", 404);
  const enabled = await twoStepEnabled(me.database, me.credential.id);
  return jsonOk({ data: { enabled, recovery_codes_left: enabled ? await recoveryCodesLeft(me.database, me.credential.id) : 0 } });
};

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const me = await self(locals);
  if (!me) return jsonError("Akun tidak ditemukan.", 404);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Payload tidak valid.", 400);
  const text = (key: string, max: number) => (typeof body[key] === "string" ? (body[key] as string).slice(0, max) : "");
  const password = text("current_password", 1024);
  if (!password) return jsonError("Masukkan password saat ini.", 400);

  try {
    if (body.action === "begin") {
      const result = await beginEnrollment(me.database, me.credential.id, password, me.credential.email || me.credential.username);
      if (!result.ok) return jsonError(result.error, 400);
      return jsonOk({ data: { secret: result.secret, otpauth_uri: result.uri } });
    }
    if (body.action === "confirm") {
      const result = await confirmEnrollment(me.database, me.credential.id, { password, secret: text("secret", 64), code: text("code", 16) });
      if (!result.ok) return jsonError(result.error, 400);
      // Every session of this user ended with the enrollment, this one too: the next sign-in asks for a code.
      cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
      return jsonOk({ message: "Verifikasi dua langkah aktif. Simpan kode cadangan, lalu masuk lagi.", data: { recovery_codes: result.recoveryCodes } });
    }
    if (body.action === "disable") {
      const result = await disableOwnTwoStep(me.database, me.credential.id, { password, code: text("code", 16) });
      if (!result.ok) return jsonError(result.error, 400);
      return jsonOk({ message: "Verifikasi dua langkah dimatikan." });
    }
    return jsonError("Aksi tidak dikenal.", 400);
  } catch (error) {
    console.error("admin-two-step", error);
    return jsonError("Gagal menyimpan verifikasi dua langkah.", 500);
  }
};
