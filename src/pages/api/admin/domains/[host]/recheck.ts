import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../../lib/api.ts";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { noticeDomainIfActive } from "../../../../../platform/notify.ts";
import { hostnameApiFromEnv, refreshDomain } from "../../../../../platform/hostnames.ts";

export const prerender = false;

/** "Cek lagi": restart validation at Cloudflare, then read the state back. */
export const POST: APIRoute = async ({ params, locals }) => {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const tenantId = locals.tenantContext?.tenantId;
  const api = hostnameApiFromEnv(env);
  if (!platformDb || !tenantId || !api) return jsonError("Domain belum tersedia.", 503);
  const result = await refreshDomain(platformDb, api, tenantId, String(params.host ?? ""), { recheck: true });
  if (result.ok && locals.tenantContext) {
    // T-44: a custom domain that is now active is announced to the operator once.
    noticeDomainIfActive(getRuntimeEnv(locals) as Record<string, unknown> | undefined, platformDb, { tenantId, slug: locals.tenantContext.slug, storeName: locals.tenant?.name }, result.value, (task) => locals.cfContext?.waitUntil(task));
  }
  return result.ok ? jsonOk({ data: { domain: result.value } }) : jsonError(result.error, result.status);
};
