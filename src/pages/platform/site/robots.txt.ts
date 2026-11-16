import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env";
import { canonicalUrl } from "../../../platform/site/site.ts";

export const prerender = false;

/** robots.txt of the platform host (T-40): the marketing site is crawlable; admin and APIs are not. */
export const GET: APIRoute = ({ locals }) => {
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const body = ["User-agent: *", "Disallow: /platform/", "Disallow: /api/", "Allow: /", "", `Sitemap: ${canonicalUrl(env, "/sitemap.xml")}`, ""].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
