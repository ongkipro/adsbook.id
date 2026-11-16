import type { APIRoute } from "astro";
import { getAdminCredential } from "../../lib/admin-credentials.ts";
import { storeAdminSession } from "../../lib/admin-session.ts";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, signJwt } from "../../lib/auth.ts";
import { resolveAuthSecret } from "../../lib/auth-secret.ts";
import { getRuntimeEnv } from "../../lib/env.ts";
import { tenantDatabase } from "../../lib/tenant-database.ts";
import { consumeHandoff, HANDOFF_FETCH_SITE_HEADER, HANDOFF_ORIGIN_HEADER, isPlatformHandoffOrigin } from "../../platform/handoff.ts";
import { platformHosts } from "../../platform/host.ts";

export const prerender = false;

/** Any failure: 401 with a way forward, and no session. */
function refused() {
  return new Response(
    `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Tautan masuk tidak berlaku</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0f172a">
<h1 style="font-size:1.25rem">Tautan masuk tidak berlaku</h1>
<p>Tautan ini sudah dipakai atau kedaluwarsa. Masuk dengan email dan password toko Anda.</p>
<p><a href="/hello" style="color:#1d4ed8;font-weight:600">Masuk ke toko</a></p></body></html>`,
    { status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/**
 * API-8 / IAM-8: redeem a signup handoff on the seller host and start the
 * owner's session. The token is in the POST body only; the request log keeps
 * the route pattern, never a body or query.
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const tenant = locals.tenantContext;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const database = tenantDatabase(locals);
  if (!tenant || tenant.hostKind !== "subdomain" || !platformDb || !database) return refused();
  const hosts = platformHosts(typeof env?.PLATFORM_HOSTS === "string" ? env.PLATFORM_HOSTS : null);
  // The browser's Origin, moved here by the Worker entry (prepareHandoffRequest).
  if (!isPlatformHandoffOrigin(request.headers.get(HANDOFF_ORIGIN_HEADER), request.headers.get(HANDOFF_FETCH_SITE_HEADER), hosts)) return refused();

  const form = await request.formData().catch(() => null);
  const tenantId = await consumeHandoff(platformDb, form?.get("token"), tenant.host, "signup");
  if (!tenantId || tenantId !== tenant.tenantId) return refused();

  const owner = await platformDb
    .prepare("SELECT owner_email FROM tenants WHERE id = ? AND status = 'active'")
    .bind(tenantId)
    .first<{ owner_email: string }>();
  const credential = owner ? await getAdminCredential(database, owner.owner_email) : null;
  const secret = await resolveAuthSecret(database, tenantId);
  if (!credential || credential.role !== "owner" || secret.length < 32) return refused();

  const { token, session } = await signJwt({ username: credential.username, role: credential.role }, secret);
  await storeAdminSession(database, session, credential);
  cookies.set(SESSION_COOKIE_NAME, token, { ...SESSION_COOKIE_OPTIONS, maxAge: 60 * 60 * 24 });
  return redirect("/admin/dashboard", 303);
};
