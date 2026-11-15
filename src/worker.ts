import type { ExecutionContext, ExportedHandler } from "@cloudflare/workers-types";
import { handle } from "@astrojs/cloudflare/handler";
import { CMS_VERSION } from "./lib/version.ts";
import { ensureControlPlane } from "./platform/control-plane.ts";
import { armTenantAlarm, openTenantDb, TenantUnavailableError } from "./platform/tenant-db.ts";
import { runPlatformJobs } from "./platform/jobs.ts";
// One SQLite Durable Object per tenant (ADR-039, TD-3); src/platform/tenant-db.ts opens it.
export { TenantStore } from "./platform/tenant-store.ts";
type AstroRequest = Parameters<typeof handle>[0];

/** MIG-1: tenants migrated by the cron per run, oldest schema first. */
export const CRON_MIGRATION_BATCH = 50;

/**
 * The platform cron (MULTI-TENANT-DESIGN §8). It runs no tenant's
 * maintenance itself — each tenant's `TenantStore` alarm does, in its own
 * invocation (TEN-5). It:
 * 1. migrates up to `CRON_MIGRATION_BATCH` active tenants whose schema is
 *    behind this release and that received no request, each through the T-18
 *    protocol (bookmark first; `openTenantDb` records the new version);
 * 2. arms the hourly alarm of every active tenant that has none;
 * 3. runs the platform's own retention job (`src/platform/jobs.ts`).
 * One tenant's failure is logged with its id and the next tenant runs.
 */
export async function runPlatformCron(
  env: CloudflareRuntimeEnv,
  scheduledTime: number,
  _context: ExecutionContext,
): Promise<{ migrated: string[]; armed: number; failed: string[] }> {
  const platformDb = env.PLATFORM_DB;
  if (!platformDb) {
    console.error("scheduled-no-platform-bindings");
    return { migrated: [], armed: 0, failed: [] };
  }
  await ensureControlPlane(platformDb);
  const target = CMS_VERSION.schemaVersion;
  const failed: string[] = [];

  const behind = (
    await platformDb
      .prepare(
        `SELECT id, cache_version FROM tenants WHERE status = 'active' AND schema_version < ?
         ORDER BY schema_version, id LIMIT ?`,
      )
      .bind(target, CRON_MIGRATION_BATCH)
      .all<{ id: string; cache_version: number }>()
  ).results;
  const migrated: string[] = [];
  for (const { id, cache_version } of behind) {
    try {
      await openTenantDb(env, { tenantId: id, cacheVersion: Number(cache_version) }, target);
      migrated.push(id);
    } catch (error) {
      failed.push(id);
      console.error("scheduled-tenant-migration-failed", {
        tenant_id: id,
        reason: error instanceof TenantUnavailableError ? error.reason : "migration_failed",
      });
    }
  }

  const active = (
    await platformDb.prepare("SELECT id FROM tenants WHERE status = 'active' ORDER BY id").all<{ id: string }>()
  ).results;
  let armed = 0;
  for (const { id } of active) {
    try {
      if (await armTenantAlarm(env, id)) armed += 1;
    } catch (error) {
      if (!failed.includes(id)) failed.push(id);
      console.error("scheduled-tenant-arm-failed", { tenant_id: id, error: String(error) });
    }
  }

  try {
    const jobs = await runPlatformJobs(platformDb, new Date(scheduledTime));
    console.info("scheduled-platform-jobs", jobs);
  } catch (error) {
    console.error("scheduled-platform-jobs-failed", String(error));
  }
  return { migrated, armed, failed };
}

export default {
  fetch(request, env, ctx) {
    // @astrojs/cloudflare's public handler uses the DOM Request type while
    // ExportedHandler supplies the structurally compatible Workers Request.
    return handle(request as unknown as AstroRequest, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    await runPlatformCron(env, controller.scheduledTime, ctx);
  },
} satisfies ExportedHandler<CloudflareRuntimeEnv>;
