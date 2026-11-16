import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { ensureControlPlane } from "../../../platform/control-plane.ts";
import { checkSlug, suggestFreeSlugs } from "../../../platform/slugs.ts";

export const prerender = false;

/** UX-1 live availability: free, taken, or not allowed — plus 3 free suggestions when taken/reserved. */
export const GET: APIRoute = async ({ locals, url }) => {
  const raw = url.searchParams.get("slug") ?? "";
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  const check = checkSlug(raw);
  if (!check.ok) {
    let suggestions: string[] = [];
    if (check.reserved && platformDb) {
      await ensureControlPlane(platformDb);
      suggestions = await suggestFreeSlugs(platformDb, raw, 3);
    }
    return Response.json({ success: true, data: { available: false, reason: check.error, suggestions } });
  }
  if (!platformDb) return Response.json({ success: false, error: "Belum tersedia." }, { status: 503 });
  await ensureControlPlane(platformDb);
  const taken = await platformDb.prepare("SELECT 1 AS yes FROM tenants WHERE slug = ?").bind(check.slug).first();
  if (!taken) {
    return Response.json({ success: true, data: { available: true, reason: "", suggestions: [] } });
  }
  const suggestions = await suggestFreeSlugs(platformDb, check.slug, 3);
  return Response.json({
    success: true,
    data: { available: false, reason: "Alamat toko ini sudah dipakai.", suggestions },
  });
};
