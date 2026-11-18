import type { APIRoute } from "astro";
import { getRuntimeEnv } from "../../../lib/env.ts";
import { platformLlmsTxt } from "../../../platform/site/site.ts";

export const prerender = false;

/** adsbook.id described for AI assistants (llmstxt.org): the public pages only, never sign-in or admin. */
export const GET: APIRoute = ({ locals }) => {
  const env = (getRuntimeEnv(locals) ?? {}) as Record<string, unknown>;
  return new Response(platformLlmsTxt(env), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
