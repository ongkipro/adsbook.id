import type { ExportedHandler } from "@cloudflare/workers-types";
import { handle } from "@astrojs/cloudflare/handler";
import { runPlatformCron } from "./platform/cron.ts";
import { prepareHandoffRequest } from "./platform/handoff.ts";
// One SQLite Durable Object per tenant (ADR-039, TD-3); src/platform/tenant-db.ts opens it.
// The module exports only handlers and the Durable Object class: workerd
// refuses any other export as an entrypoint.
export { TenantStore } from "./platform/tenant-store.ts";
type AstroRequest = Parameters<typeof handle>[0];

export default {
  fetch(request, env, ctx) {
    // @astrojs/cloudflare's public handler uses the DOM Request type while
    // ExportedHandler supplies the structurally compatible Workers Request.
    // IAM-8: the one cross-site form POST, carried past Astro's origin check.
    const prepared = prepareHandoffRequest(request as unknown as Request);
    return handle(prepared as unknown as AstroRequest, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await runPlatformCron(env, controller.scheduledTime, ctx);
  },
} satisfies ExportedHandler<CloudflareRuntimeEnv>;
