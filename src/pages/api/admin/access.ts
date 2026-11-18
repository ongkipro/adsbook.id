import type { APIRoute } from "astro";
import {
  hashAdminPassword,
  normalizeAdminUsername,
  validateAdminUsername,
  validateNewAdminPassword,
} from "../../../lib/admin-credentials";
import { revokeAdminSessions } from "../../../lib/admin-session";
import { jsonError, jsonOk } from "../../../lib/api";
import { isAdminRole } from "../../../lib/auth";
import { tenantDatabase } from "../../../lib/tenant-database.ts";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { claimPlatformIdentity, releasePlatformIdentity } from "../../../platform/identities.ts";

export const prerender = false;

/** AUTH-LOGIN-REGISTER-UX-SPEC §1.2: a staff username or email signs in on adsbook.id/masuk, so it is unique across stores. */
const IDENTITY_TAKEN = "Username atau email ini sudah digunakan. Pilih yang lain.";

function runtime(locals: App.Locals) {
  return {
    database: tenantDatabase(locals),
    env: getRuntimeEnv(locals),
    tenantId: locals.tenantContext?.tenantId,
  };
}

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.admin || locals.admin.role !== "owner") {
    return jsonError("Hanya Owner yang berhak mengelola akses pengguna.", 403);
  }
  const { database } = runtime(locals);
  if (!database) return jsonError("Database akses belum tersedia.", 503);
  try {
    const result = await database
      .prepare(
        `SELECT id, username, display_name, email, role, must_change_password, updated_at
        FROM admin_credentials
        ORDER BY CASE role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          WHEN 'advertiser' THEN 2
          WHEN 'customer_service' THEN 3
          ELSE 4
        END, username`,
      )
      .all();
    return jsonOk({ data: { users: result.results ?? [] } });
  } catch (error) {
    console.error("admin-access-get", error);
    return jsonError("Gagal memuat akses pengguna.", 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.admin || locals.admin.role !== "owner") {
    return jsonError("Hanya Owner yang berhak mengelola akses pengguna.", 403);
  }
  const { database, env, tenantId } = runtime(locals);
  if (!database) return jsonError("Database akses belum tersedia.", 503);
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return jsonError("Payload tidak valid.", 400);

  const username = normalizeAdminUsername(body.username);
  const displayName = String(body.display_name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 160);
  const password = typeof body.password === "string" ? body.password : "";
  const role = body.role;
  if (!isAdminRole(role) || role === "owner") {
    return jsonError("Role harus admin, advertiser, atau customer service.", 422);
  }
  if (!validateAdminUsername(username)) {
    return jsonError(
      "Username harus 3–64 karakter: huruf kecil, angka, titik, garis bawah, atau tanda hubung.",
      422,
    );
  }
  if (displayName.length < 2) {
    return jsonError("Nama pengguna minimal 2 karakter.", 422);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonError("Email pengguna tidak valid.", 422);
  }
  const passwordError = validateNewAdminPassword(password, username);
  if (passwordError) return jsonError(passwordError, 422);

  // Claimed on the platform before the store writes the credential, released if that write fails.
  const claimed: Array<[string, "staff_username" | "staff_email"]> = [];
  const release = () => Promise.all(claimed.map(([identifier, kind]) => releasePlatformIdentity(env, tenantId, identifier, kind).catch(() => undefined)));
  const wanted: Array<[string, "staff_username" | "staff_email"]> = [[username, "staff_username"]];
  if (email && email !== username) wanted.push([email, "staff_email"]);
  for (const [identifier, kind] of wanted) {
    const claim = await claimPlatformIdentity(env, tenantId, identifier, kind);
    if (claim === "taken") {
      await release();
      return jsonError(IDENTITY_TAKEN, 409);
    }
    if (claim === "claimed") claimed.push([identifier, kind]);
  }

  try {
    const passwordHash = await hashAdminPassword(password);
    const now = new Date().toISOString();
    const result = await database
      .prepare(
        `INSERT INTO admin_credentials (
          username, display_name, email, role, password_hash,
          must_change_password, updated_at, notification_floor_id
        ) VALUES (?, ?, ?, ?, ?, 1, ?,
          COALESCE((SELECT MAX(id) FROM notifications), 0))`,
      )
      .bind(username, displayName, email || null, role, passwordHash, now)
      .run();
    if (!result.success) throw new Error("D1 rejected user creation.");
    return jsonOk(
      {
        message: `Pengguna ${username} berhasil dibuat sebagai ${role}.`,
        data: {
          id: result.meta.last_row_id,
          username,
          display_name: displayName,
          email: email || null,
          role,
          must_change_password: 1,
          updated_at: now,
        },
      },
      201,
    );
  } catch (error) {
    await release();
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("admin_credentials.username")) {
      return jsonError("Username sudah digunakan.", 409);
    }
    console.error("admin-access-post", error);
    return jsonError("Gagal membuat pengguna.", 500);
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  if (!locals.admin || locals.admin.role !== "owner") {
    return jsonError("Hanya Owner yang berhak mengelola akses pengguna.", 403);
  }
  const { database, env, tenantId } = runtime(locals);
  if (!database) {
    return jsonError("Penyimpanan akses belum tersedia.", 503);
  }
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return jsonError("Payload tidak valid.", 400);

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) {
    return jsonError("ID pengguna tidak valid.", 400);
  }

  try {
    const existing = await database
      .prepare(
        "SELECT id, username, role, email FROM admin_credentials WHERE id = ? LIMIT 1",
      )
      .bind(id)
      .first<{ id: number; username: string; role: string; email: string | null }>();

    if (!existing) return jsonError("Pengguna tidak ditemukan.", 404);
    if (existing.role === "owner") {
      return jsonError("Akun owner tidak dapat diubah dari halaman ini.", 409);
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.role !== undefined) {
      const role = body.role;
      if (!isAdminRole(role) || role === "owner") {
        return jsonError(
          "Role harus admin, advertiser, atau customer service.",
          422,
        );
      }
      updates.push("role = ?");
      params.push(role);
    }

    if (body.display_name !== undefined) {
      const displayName = String(body.display_name || "")
        .trim()
        .slice(0, 120);
      if (displayName.length < 2) {
        return jsonError("Nama pengguna minimal 2 karakter.", 422);
      }
      updates.push("display_name = ?");
      params.push(displayName);
    }

    // A changed email moves its platform claim: the new one first, the old one after the write.
    let emailClaim: { next: string; previous: string } | null = null;
    if (body.email !== undefined) {
      const email = String(body.email || "")
        .trim()
        .toLowerCase()
        .slice(0, 160);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonError("Email pengguna tidak valid.", 422);
      }
      updates.push("email = ?");
      params.push(email || null);
      const previous = (existing.email ?? "").toLowerCase();
      if (email !== previous) emailClaim = { next: email, previous };
    }

    let passwordReset = false;
    if (typeof body.password === "string" && body.password.length > 0) {
      const passwordError = validateNewAdminPassword(
        body.password,
        existing.username,
      );
      if (passwordError) return jsonError(passwordError, 422);
      const passwordHash = await hashAdminPassword(body.password);
      updates.push("password_hash = ?", "must_change_password = 1");
      params.push(passwordHash);
      passwordReset = true;
    }

    if (updates.length === 0) {
      return jsonError("Tidak ada perubahan data.", 400);
    }

    let claimedEmail = "";
    if (emailClaim?.next && emailClaim.next !== existing.username) {
      const claim = await claimPlatformIdentity(env, tenantId, emailClaim.next, "staff_email");
      if (claim === "taken") return jsonError(IDENTITY_TAKEN, 409);
      if (claim === "claimed") claimedEmail = emailClaim.next;
    }

    const now = new Date().toISOString();
    updates.push("updated_at = ?");
    params.push(now);
    params.push(id);

    try {
      await database
        .prepare(
          `UPDATE admin_credentials SET ${updates.join(", ")} WHERE id = ? AND role != 'owner'`,
        )
        .bind(...params)
        .run();
    } catch (error) {
      if (claimedEmail) await releasePlatformIdentity(env, tenantId, claimedEmail, "staff_email").catch(() => undefined);
      throw error;
    }
    if (emailClaim?.previous && emailClaim.previous !== existing.username) {
      await releasePlatformIdentity(env, tenantId, emailClaim.previous, "staff_email");
    }

    await revokeAdminSessions(database, existing.username);

    const updatedUser = await database
      .prepare(
        "SELECT id, username, display_name, email, role, must_change_password, updated_at FROM admin_credentials WHERE id = ? LIMIT 1",
      )
      .bind(id)
      .first();

    return jsonOk({
      message: passwordReset
        ? `Password ${existing.username} berhasil di-reset. Sesi pengguna telah dicabut.`
        : `Akses pengguna ${existing.username} berhasil diperbarui.`,
      data: updatedUser,
    });
  } catch (error) {
    console.error("admin-access-patch", error);
    return jsonError("Gagal memperbarui akses pengguna.", 500);
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  if (!locals.admin || locals.admin.role !== "owner") {
    return jsonError("Hanya Owner yang berhak mengelola akses pengguna.", 403);
  }
  const { database, env, tenantId } = runtime(locals);
  if (!database) {
    return jsonError("Penyimpanan akses belum tersedia.", 503);
  }
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id < 1) {
    return jsonError("ID pengguna tidak valid.", 400);
  }
  try {
    const row = await database
      .prepare(
        "SELECT username, role, email FROM admin_credentials WHERE id = ? LIMIT 1",
      )
      .bind(id)
      .first<{ username: string; role: string; email: string | null }>();
    if (!row) return jsonError("Pengguna tidak ditemukan.", 404);
    if (row.role === "owner") {
      return jsonError("Akun owner tidak dapat dihapus dari halaman ini.", 409);
    }
    const result = await database
      .prepare("DELETE FROM admin_credentials WHERE id = ? AND role != 'owner'")
      .bind(id)
      .run();
    if (result.meta.changes !== 1) {
      return jsonError("Pengguna tidak ditemukan.", 404);
    }
    await revokeAdminSessions(database, row.username);
    // The removed user's sign-in names are free again, here and in every other store.
    await releasePlatformIdentity(env, tenantId, row.username, "staff_username");
    if (row.email) await releasePlatformIdentity(env, tenantId, row.email, "staff_email");
    return jsonOk({ message: `Akses ${row.username} dicabut.` });
  } catch (error) {
    console.error("admin-access-delete", error);
    return jsonError("Gagal mencabut akses pengguna.", 500);
  }
};
