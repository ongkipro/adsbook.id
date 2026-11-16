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

/** Safe post-signup destinations on the seller's own admin surface. */
export function resolveHandoffTarget(raw: unknown): string {
  if (typeof raw !== "string") return "/admin/dashboard";
  const trimmed = raw.trim();
  if (/^\/admin\/(?:setup|dashboard|billing)(?:\?[A-Za-z0-9=&_-]{1,64})?$/.test(trimmed)) {
    return trimmed;
  }
  return "/admin/dashboard";
}

/** Any failure: 401 with a clear way forward on the seller's login page, and no session. */
function refused() {
  return new Response(
    `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sesi masuk otomatis sudah berakhir - adsbook.id</title>
<body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#faf7f2;margin:0;padding:12vh 1rem;color:#1c1917">
<main style="max-width:30rem;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:1.75rem">
<p style="margin:0;font-weight:800;font-size:1.05rem">adsbook<span style="color:#c2410c">.id</span></p>
<h1 style="margin:0.75rem 0 0;font-size:1.3rem;line-height:1.25">Tautan masuk otomatis sudah dipakai</h1>
<p style="margin:0.75rem 0 1.25rem;color:#57534e;line-height:1.55">Toko Anda sudah siap. Masuk menggunakan email dan password yang baru Anda daftarkan.</p>
<a href="/hello" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0.6rem 1.2rem;border-radius:8px;background:#c2410c;color:#fff;font-weight:700;text-decoration:none">Masuk ke Admin Toko</a>
</main></body></html>`,
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
  return redirect(resolveHandoffTarget(form?.get("next")), 303);
};
