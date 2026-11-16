import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../lib/env.ts";
import { tenantDatabase } from "../../lib/tenant-database.ts";
import { redeemOwnerRecovery } from "../../platform/admin/recovery.ts";

export const prerender = false;

/** IAM-9 on the seller host: same-origin form from /pemulihan; token in the body only. */
export const POST: APIRoute = async ({ request, locals, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ success: false, error: "Forbidden request origin" }, { status: 403 });
  }
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const database = tenantDatabase(locals);
  const tenant = locals.tenantContext;
  if (!platformDb || !database || !tenant) return Response.json({ success: false, error: "Belum tersedia." }, { status: 503 });
  const body = (await request.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
  const result = await redeemOwnerRecovery(platformDb, database, tenant, body?.token, body?.password);
  return result.ok
    ? Response.json({ success: true, message: "Password baru tersimpan. Semua sesi lama sudah keluar; silakan masuk." })
    : Response.json({ success: false, error: result.error }, { status: result.status });
};
