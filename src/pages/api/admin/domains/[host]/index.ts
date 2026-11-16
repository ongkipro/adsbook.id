import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../../lib/api.ts";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { hostnameApiFromEnv, refreshDomain, removeDomain } from "../../../../../platform/hostnames.ts";

export const prerender = false;

function context(locals: App.Locals) {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  return {
    platformDb: env?.PLATFORM_DB as D1Database | undefined,
    tenantId: locals.tenantContext?.tenantId,
    api: hostnameApiFromEnv(env),
  };
}

/** The domain's current Cloudflare state, activating routing when both states are active (DOM-4). */
export const GET: APIRoute = async ({ params, locals }) => {
  const { platformDb, tenantId, api } = context(locals);
  if (!platformDb || !tenantId || !api) return jsonError("Domain belum tersedia.", 503);
  const result = await refreshDomain(platformDb, api, tenantId, String(params.host ?? ""));
  return result.ok ? jsonOk({ data: { domain: result.value } }) : jsonError(result.error, result.status);
};

/** DOM-5: removal deletes the Cloudflare hostname; the host is quarantined first. */
export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const { platformDb, tenantId, api } = context(locals);
  if (!platformDb || !tenantId || !api) return jsonError("Domain belum tersedia.", 503);
  // T-43: `?only=host` removes just this hostname (switching root -> `www` only keeps `www`).
  const scope = new URL(request.url).searchParams.get("only") === "host" ? "host" : "group";
  const result = await removeDomain(platformDb, api, tenantId, String(params.host ?? ""), new Date(), scope);
  return result.ok
    ? jsonOk({ message: `Domain ${result.value.removed.join(" dan ")} dihapus.`, data: result.value })
    : jsonError(result.error, result.status);
};
