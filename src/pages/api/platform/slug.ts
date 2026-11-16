import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { ensureControlPlane } from "../../../platform/control-plane.ts";
import { checkSlug } from "../../../platform/slugs.ts";

export const prerender = false;

/** UX-1 live availability: free, taken, or not allowed. A hint only; signup decides. */
export const GET: APIRoute = async ({ locals, url }) => {
  const check = checkSlug(url.searchParams.get("slug"));
  if (!check.ok) return Response.json({ success: true, data: { available: false, reason: check.error } });
  const platformDb = (getRuntimeEnv(locals) as Record<string, unknown> | undefined)?.PLATFORM_DB as D1Database | undefined;
  if (!platformDb) return Response.json({ success: false, error: "Belum tersedia." }, { status: 503 });
  await ensureControlPlane(platformDb);
  const taken = await platformDb.prepare("SELECT 1 AS yes FROM tenants WHERE slug = ?").bind(check.slug).first();
  return Response.json({ success: true, data: { available: !taken, reason: taken ? "Alamat toko ini sudah dipakai." : "" } });
};
