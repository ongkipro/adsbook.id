/**
 * One tenant's hourly housekeeping, in its own `TenantStore` alarm (TEN-5,
 * MULTI-TENANT-DESIGN §8). Each alarm is its own invocation, so one tenant's
 * outbound calls spend that invocation's subrequest budget alone, and one
 * tenant's failure never reaches another's run.
 *
 * The decision order is the contract:
 * 1. no tenant id stored → nothing to run (the cron arms it again);
 * 2. the control plane says the tenant is not active → no run and no re-arm
 *    (suspended, recovery and purging tenants do no work; resume re-arms);
 * 3. the store is behind the bundled chain, or in recovery → no maintenance
 *    (MIG-1: new code never runs on an old schema), re-arm, log;
 * 4. otherwise run maintenance with the tenant's own identity, log a failure
 *    with its tenant id, and re-arm either way.
 */
import type { SchemaState } from "./store-core.ts";
import { billingState, isLive } from "./billing.ts";

/** The hourly cadence; the platform cron re-arms an alarm that went missing. */
export const TENANT_ALARM_INTERVAL_MS = 60 * 60 * 1000;

export type TenantRow = {
  status: string;
  cache_version: number;
  primary_host: string | null;
  is_demo?: number | null;
  subscription_ends_at?: string | null;
  grace_ends_at?: string | null;
};

export type TenantAlarmDeps = {
  tenantId: string | null;
  now: number;
  schemaState(): SchemaState;
  readTenant(tenantId: string): Promise<TenantRow | null>;
  maintain(tenantId: string, scheduledTime: number, primaryHost: string | null, adSignalsPaused: boolean): Promise<void>;
  setAlarm(at: number): Promise<void>;
  /** OBS-3: the run's outcome on the control plane (heartbeat, backlog, last error). */
  recordHealth?(tenantId: string, outcome: { ok: boolean; error?: string }): Promise<void>;
};

export type TenantAlarmOutcome = "ran" | "failed" | "schema_behind" | "inactive" | "no_tenant";

export async function runTenantAlarm(deps: TenantAlarmDeps): Promise<TenantAlarmOutcome> {
  const { tenantId, now } = deps;
  if (!tenantId) {
    console.error("tenant-alarm-no-tenant");
    return "no_tenant";
  }
  const tenant = await deps.readTenant(tenantId);
  if (!tenant || tenant.status !== "active") {
    console.info("tenant-alarm-inactive", { tenant_id: tenantId, status: tenant?.status ?? "missing" });
    return "inactive";
  }
  const rearm = () => deps.setAlarm(now + TENANT_ALARM_INTERVAL_MS);
  const state = deps.schemaState();
  if (state.recovery || state.historyUnknown || state.applied < state.bundled) {
    console.error("tenant-alarm-schema-behind", {
      tenant_id: tenantId,
      applied: state.applied,
      bundled: state.bundled,
      recovery: state.recovery,
    });
    await rearm();
    return "schema_behind";
  }
  const health = (outcome: { ok: boolean; error?: string }) =>
    deps.recordHealth?.(tenantId, outcome).catch((error) => console.error("tenant-alarm-health-failed", { tenant_id: tenantId, error: String(error) }));
  try {
    // ADR-041 & PR-26: outbox drains and provider reconciliation stop while a
    // store is not live, and ALWAYS stay paused on the demo store so dummy
    // orders never trigger outbound provider or ad-platform calls.
    const paused = Number(tenant.is_demo) === 1 || !isLive(billingState({ subscriptionEndsAt: tenant.subscription_ends_at, graceEndsAt: tenant.grace_ends_at }, new Date(now)));
    await deps.maintain(tenantId, now, tenant.primary_host, paused);
    await health({ ok: true });
    return "ran";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("tenant-alarm-failed", { tenant_id: tenantId, error: message });
    await health({ ok: false, error: message.slice(0, 300) });
    return "failed";
  } finally {
    await rearm();
  }
}

/** The control-plane row an alarm reads first: status, cache version, primary host. */
export async function readTenantRow(platformDb: D1Database, tenantId: string): Promise<TenantRow | null> {
  return platformDb
    .prepare(
      `SELECT t.status, t.cache_version, t.is_demo, t.subscription_ends_at, t.grace_ends_at, h.host AS primary_host FROM tenants t
       LEFT JOIN tenant_hosts h ON h.tenant_id = t.id AND h.is_primary = 1 AND h.status = 'active'
       WHERE t.id = ?`,
    )
    .bind(tenantId)
    .first<TenantRow>();
}

/**
 * OBS-3: the alarm's heartbeat on the control plane. A successful run moves
 * `heartbeat_at`; a failed one records its error and leaves the heartbeat to
 * age, so the platform admin sees it as stale after two hours.
 */
export async function recordTenantHealth(
  platformDb: D1Database,
  tenantId: string,
  outcome: { ok: boolean; error?: string; backlog?: number | null },
  now = new Date(),
): Promise<void> {
  await platformDb
    .prepare(
      `INSERT INTO tenant_health (tenant_id, heartbeat_at, outbox_backlog, last_error) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET
         heartbeat_at = COALESCE(excluded.heartbeat_at, tenant_health.heartbeat_at),
         outbox_backlog = COALESCE(excluded.outbox_backlog, tenant_health.outbox_backlog),
         last_error = excluded.last_error`,
    )
    .bind(tenantId, outcome.ok ? now.toISOString() : null, outcome.backlog ?? null, outcome.ok ? null : outcome.error ?? "failed")
    .run();
}
