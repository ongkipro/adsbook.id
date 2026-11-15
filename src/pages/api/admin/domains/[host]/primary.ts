import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../../lib/api.ts";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { resolveAuthSecret } from "../../../../../lib/auth-secret.ts";
import { tenantDatabase } from "../../../../../lib/tenant-database.ts";
import { probeHost, setPrimaryDomain } from "../../../../../platform/hostnames.ts";

export const prerender = false;

/** Promote an active host to primary; a custom one only after its HTTPS probe answers this tenant. */
export const POST: APIRoute = async ({ params, locals }) => {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const tenantId = locals.tenantContext?.tenantId;
  if (!platformDb || !tenantId) return jsonError("Domain belum tersedia.", 503);
  // The proof key is the tenant's own session key, read from its own store.
  const secret = await resolveAuthSecret(tenantDatabase(locals), tenantId);
  const result = await setPrimaryDomain(platformDb, tenantId, String(params.host ?? ""), (host) => probeHost(host, secret));
  return result.ok
    ? jsonOk({ message: `${result.value.host} sekarang domain utama toko.`, data: { domain: result.value } })
    : jsonError(result.error, result.status);
};
