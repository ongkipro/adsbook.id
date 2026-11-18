import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { ROBOTS_DISALLOW_ALL, robotsTxt } from "../../../lib/robots.ts";
import { PLATFORM_CONSOLE_HOST } from "../../../platform/host.ts";
import { canonicalUrl } from "../../../platform/site/site.ts";

export const prerender = false;

/**
 * robots.txt of the platform hosts (T-40; PLATFORM-SEO-AND-VISUAL-BANNERS-SPEC §2).
 * The site: crawlable except the console and APIs, with /daftar and /masuk left
 * crawlable so their `noindex` is read. The console host: nothing at all.
 */
export const GET: APIRoute = ({ locals }) => {
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  const body = locals.platform?.host === PLATFORM_CONSOLE_HOST
    ? ROBOTS_DISALLOW_ALL
    : robotsTxt(["/platform/", "/api/"], canonicalUrl(env, "/sitemap.xml"));
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
