import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env";
import { SITE_PAGES, canonicalUrl } from "../../../platform/site/site.ts";

export const prerender = false;

/** sitemap.xml of the platform host (T-40): every marketing and legal page, by canonical URL. */
export const GET: APIRoute = ({ locals }) => {
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const urls = Object.values(SITE_PAGES).map((page) => `  <url><loc>${canonicalUrl(env, page.path)}</loc></url>`);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
