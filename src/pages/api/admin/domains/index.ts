import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../lib/api.ts";
import { getRuntimeEnv } from "../../../../lib/env.ts";
import {
  claimDomain,
  replaceDomain,
  CNAME_TARGET,
  hostnameApiFromEnv,
  listDomains,
  type ClaimMode,
} from "../../../../platform/hostnames.ts";

export const prerender = false;

/**
 * API-5: the tenant's domains (owner and admin roles). The tenant is the
 * gate's, never a request field; Cloudflare is reached only through the
 * platform's own credentials.
 */
function context(locals: App.Locals) {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const tenantId = locals.tenantContext?.tenantId;
  return { platformDb, tenantId, api: hostnameApiFromEnv(env) };
}

export const GET: APIRoute = async ({ locals }) => {
  const { platformDb, tenantId, api } = context(locals);
  if (!platformDb || !tenantId) return jsonError("Domain belum tersedia.", 503);
  return jsonOk({
    data: { domains: await listDomains(platformDb, tenantId), cname_target: CNAME_TARGET, custom_domains_enabled: Boolean(api) },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { platformDb, tenantId, api } = context(locals);
  if (!platformDb || !tenantId) return jsonError("Domain belum tersedia.", 503);
  if (!api) return jsonError("Domain sendiri belum bisa ditambahkan di platform ini.", 503);
  const body = (await request.json().catch(() => null)) as { host?: unknown; mode?: unknown; replace?: unknown } | null;
  const mode: ClaimMode = body?.mode === "www" || body?.mode === "subdomain" ? body.mode : "root";
  // One store, one domain: `replace` swaps the current domain for this one (validated first).
  const replace = body?.replace === true;
  const result = replace
    ? await replaceDomain(platformDb, api, tenantId, body?.host, mode)
    : await claimDomain(platformDb, api, tenantId, body?.host, mode);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(
    {
      message: replace
        ? "Domain diganti. Arahkan DNS domain baru lalu klik \"Cek lagi\"; sampai aktif, toko dibuka di alamat adsbook.my.id."
        : "Domain ditambahkan. Arahkan DNS lalu klik \"Cek lagi\".",
      data: { domains: result.value, cname_target: CNAME_TARGET },
    },
    201,
  );
};
