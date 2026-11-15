import type { APIRoute } from 'astro';
import { SESSION_COOKIE_NAME, getSessionCookie, verifyJwt } from '../../../lib/auth';
import { deleteAdminSession } from '../../../lib/admin-session';
import { resolveAuthSecret } from '../../../lib/auth-secret';
import { tenantDatabase } from '../../../lib/tenant-database.ts';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const database = tenantDatabase(locals);
  const token = getSessionCookie(request);
  const session = token ? await verifyJwt(token, await resolveAuthSecret(database, locals.tenantContext?.tenantId)) : null;

  if (database && session) {
    try {
      await deleteAdminSession(database, session.jti);
    } catch (error) {
      // The cookie is cleared regardless; the row expires on its own.
      console.error('admin-logout', error);
    }
  }
  cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
  return redirect('/hello', 303);
};
