import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../../lib/api.ts";
import { resolveAuthSecret } from "../../../../../lib/auth-secret.ts";
import { getRuntimeEnv } from "../../../../../lib/env.ts";
import { tenantDatabase } from "../../../../../lib/tenant-database.ts";
import { noticeDomainIfActive } from "../../../../../platform/notify.ts";
import { hostnameApiFromEnv, probeHost } from "../../../../../platform/hostnames.ts";
import { promoteGroupIfReady, refreshDomainGroup } from "../../../../../platform/domain-poll.ts";

export const prerender = false;

/**
 * "Cek lagi": restart validation at Cloudflare for every host of the domain
 * (`domain.com` and `www.domain.com` together), read the state back, and once
 * the domain is active make it the store's primary after its HTTPS probe
 * (Paduka, 2026-11-16: one domain per store, no second click).
 */
export const POST: APIRoute = async ({ params, locals }) => {
  const env = getRuntimeEnv(locals) as Record<string, unknown> | undefined;
  const platformDb = env?.PLATFORM_DB as D1Database | undefined;
  const tenantId = locals.tenantContext?.tenantId;
  const api = hostnameApiFromEnv(env);
  if (!platformDb || !tenantId || !api) return jsonError("Domain belum tersedia.", 503);
  const host = String(params.host ?? "");
  const result = await refreshDomainGroup(platformDb, api, tenantId, host, { recheck: true });
  if (!result.ok) return jsonError(result.error, result.status);
  if (locals.tenantContext) {
    // T-44: a custom domain that is now active is announced to the operator once.
    for (const domain of result.value) {
      noticeDomainIfActive(env, platformDb, { tenantId, slug: locals.tenantContext.slug, storeName: locals.tenant?.name }, domain, (task) => locals.cfContext?.waitUntil(task));
    }
  }
  // The proof key is the tenant's own session key, read from its own store.
  const secret = await resolveAuthSecret(tenantDatabase(locals), tenantId);
  const promotion = await promoteGroupIfReady(platformDb, tenantId, host, (target) => probeHost(target, secret));
  const message =
    promotion.outcome === "promoted"
      ? `${promotion.host} aktif dan sekarang domain utama toko. Alamat www dan adsbook.cc dialihkan (301) ke domain ini.`
      : promotion.outcome === "probe-failed"
        ? `${promotion.host} aktif di Cloudflare, tetapi belum menayangkan toko lewat HTTPS. Coba "Cek lagi" beberapa menit lagi.`
        : undefined;
  return jsonOk({ ...(message ? { message } : {}), data: { domains: result.value, promotion: promotion.outcome } });
};
