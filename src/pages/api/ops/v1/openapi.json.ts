import type { APIRoute } from "astro";
import { opsJson, validateOpsRequest } from "../../../../lib/ops-api";
import { opsOpenApiDocument } from "../../../../lib/ops-openapi";

export const prerender = false;

/** PRD A45, REQ-264: the operations contract as OpenAPI 3.1. */
export const GET: APIRoute = async ({ request, locals }) => {
  const access = await validateOpsRequest(request, locals, "openApiRead");
  if (!access.allowed) return access.response;
  // API-3: the document names this tenant's own primary host, never another's.
  const host = locals.tenantContext?.primaryHost ?? locals.tenantContext?.host;
  const document = host
    ? { ...opsOpenApiDocument, servers: [{ url: `https://${host}/api/ops/v1`, description: "This store" }] }
    : opsOpenApiDocument;
  return access.finalize(
    opsJson(document, 200, {
      ...access.headers,
      "content-type": "application/vnd.oai.openapi+json;version=3.1",
    }),
  );
};
