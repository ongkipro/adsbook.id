import type { APIRoute } from 'astro';
import {
  getAdminCredential,
  normalizeAdminUsername,
  updateAdminCredential,
} from '../../../lib/admin-credentials';
import { revokeAdminSessions } from '../../../lib/admin-session';
import { jsonError, jsonOk } from '../../../lib/api';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from '../../../lib/auth';
import { tenantDatabase } from '../../../lib/tenant-database.ts';
import { getRuntimeEnv } from '../../../lib/env.ts';
import { claimPlatformIdentity, releasePlatformIdentity, type IdentityKind } from '../../../platform/identities.ts';

export const prerender = false;

type ProfilePayload = {
  current_password?: unknown;
  username?: unknown;
  new_password?: unknown;
  confirm_password?: unknown;
};

function runtime(locals: App.Locals) {
  const database = tenantDatabase(locals);
  return { database };
}

export const GET: APIRoute = async ({ locals }) => {
  const { database } = runtime(locals);
  if (!database) return jsonError('Database profil admin belum tersedia.', 503);

  try {
    const credential = await getAdminCredential(database, locals.admin?.username);
    if (!credential) return jsonError('Kredensial admin belum tersedia.', 404);
    return jsonOk({
      data: {
        username: credential.username,
        role: credential.role,
        display_name: credential.displayName,
        email: credential.email,
        must_change_password: credential.mustChangePassword,
        updated_at: credential.updatedAt,
      },
    });
  } catch (error) {
    console.error('admin-profile-get', error);
    return jsonError('Gagal mengambil profil admin.', 500);
  }
};

export const PUT: APIRoute = async ({ request, locals, cookies }) => {
  const { database } = runtime(locals);
  if (!database) return jsonError('Penyimpanan profil admin belum tersedia.', 503);

  const body = await request.json().catch(() => null) as ProfilePayload | null;
  if (!body) return jsonError('Payload tidak valid.', 400);

  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const username = typeof body.username === 'string' ? body.username : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : '';
  if (!currentPassword || !username || !newPassword || !confirmPassword) {
    return jsonError('Username, password saat ini, dan password baru wajib diisi.', 400);
  }
  if (newPassword !== confirmPassword) return jsonError('Konfirmasi password baru tidak sama.', 400);

  try {
    const actorUsername = locals.admin?.username || '';
    // AUTH-LOGIN-REGISTER-UX-SPEC §1.2: a username signs in on adsbook.id/masuk, so a
    // new one must be free on the whole platform. Claimed first, the old one released after.
    const env = getRuntimeEnv(locals);
    const tenantId = locals.tenantContext?.tenantId;
    const kind: IdentityKind = locals.admin?.role === 'owner' ? 'owner_email' : 'staff_username';
    const nextUsername = normalizeAdminUsername(username);
    const renaming = nextUsername !== '' && nextUsername !== actorUsername;
    let claimedNew = false;
    if (renaming) {
      const claim = await claimPlatformIdentity(env, tenantId, nextUsername, kind);
      if (claim === 'taken') return jsonError('Username atau email ini sudah digunakan. Pilih yang lain.', 409);
      claimedNew = claim === 'claimed';
    }
    const result = await updateAdminCredential(
      database,
      actorUsername,
      currentPassword,
      username,
      newPassword,
    ).catch(async (error) => {
      if (claimedNew) await releasePlatformIdentity(env, tenantId, nextUsername, kind).catch(() => undefined);
      throw error;
    });
    if (!result.ok) {
      if (claimedNew) await releasePlatformIdentity(env, tenantId, nextUsername, kind).catch(() => undefined);
      return jsonError(result.error, 400);
    }
    if (renaming) await releasePlatformIdentity(env, tenantId, actorUsername, kind);

    await revokeAdminSessions(database, actorUsername);
    cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    return jsonOk({
      message: 'Profil admin diperbarui. Silakan login kembali.',
      data: { username: result.username, reauthenticate: true },
    });
  } catch (error) {
    console.error('admin-profile-put', error);
    return jsonError('Gagal memperbarui profil admin.', 500);
  }
};
