import type { APIRoute } from "astro";
import { robotsTxt } from "../lib/robots";

export const prerender = false;

/**
 * Served from the store's own identity rather than from `public/robots.txt`:
 * the static file named the reference store's domain in its `Sitemap:` line
 * and shipped that way to every install. The agent groups and why each repeats
 * the disallow list: `src/lib/robots.ts`.
 */
const DISALLOWED = ["/admin/", "/api/", "/embed/", "/hello", "/install"];

export const GET: APIRoute = ({ locals }) => {
  const origin = locals.tenant.siteUrl.replace(/\/$/, "");
  // A noindex store keeps crawling open so every page's `noindex` is seen
  // (a Disallow would hide it), but advertises no sitemap.
  const body = robotsTxt(DISALLOWED, locals.tenant.noindex ? null : `${origin}/sitemap.xml`);

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
};
