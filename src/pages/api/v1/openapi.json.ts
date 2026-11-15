import type { APIRoute } from "astro";
import { handleOptions, validateHeadlessRequest } from "../../../lib/headless-api.ts";
import { headlessOpenApiDocument } from "../../../lib/headless-openapi.ts";

export const prerender = false;
export const OPTIONS = handleOptions;

export const GET: APIRoute = async ({ request, locals }) => {
  const validation = await validateHeadlessRequest(request, locals, {
    operation: "openApiRead",
  });
  if (!validation.allowed) return validation.errorResponse;

  // API-3: the document names this tenant's own primary host, never another's.
  const host = locals.tenantContext?.primaryHost ?? locals.tenantContext?.host;
  const document = host
    ? { ...headlessOpenApiDocument, servers: [{ url: `https://${host}/api/v1`, description: "This store" }] }
    : headlessOpenApiDocument;
  return validation.finalize(new Response(JSON.stringify(document), {
    status: 200,
    headers: {
      "content-type": "application/vnd.oai.openapi+json;version=3.1",
      "cache-control": "private, max-age=300",
      ...validation.corsHeaders,
    },
  }));
};
