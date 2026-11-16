import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { BUNDLED_MIGRATIONS } from "../lib/bundled-migrations.ts";
import { splitMigrationStatements } from "../lib/schema-version.ts";
import { createTenantDb } from "./tenant-db.ts";
import { bindCredentials } from "../lib/credential-crypto.ts";
import { recordUsage } from "./plans.ts";
import { readTenantRow, recordTenantHealth, runTenantAlarm, TENANT_ALARM_INTERVAL_MS } from "./tenant-alarm.ts";
import {
  TenantStoreEngine,
  type SchemaState,
  type StatementDescriptor,
  type StatementResult,
  type StorageLike,
  type StoreKv,
} from "./store-core.ts";

/**
 * One tenant's database (ADR-039 Option D, TD-3): a SQLite-backed Durable
 * Object named by the tenant id. Every method carries the Worker↔store
 * protocol version (§4.1 item 8). The constructor reads the ledger and
 * nothing else; migrations run when the Worker asks, after it has stored a
 * PITR bookmark (`src/platform/tenant-db.ts`, MIG-1).
 */
export class TenantStore extends DurableObject {
  #engine: TenantStoreEngine | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#engine = new TenantStoreEngine(
        // The storage API's cursor generics are narrower than the engine's
        // structural `SqlLike`; the runtime object is the one the engine expects.
        ctx.storage as unknown as StorageLike,
        ctx.storage.kv as StoreKv,
        BUNDLED_MIGRATIONS,
        splitMigrationStatements,
      );
    });
  }

  get #store(): TenantStoreEngine {
    if (!this.#engine) throw new Error("TENANT_STORE_NOT_READY");
    return this.#engine;
  }

  async query(protocol: number, statement: StatementDescriptor, raw: boolean): Promise<StatementResult> {
    this.#store.checkProtocol(protocol);
    return this.#store.query(statement, raw);
  }

  async batch(protocol: number, statements: StatementDescriptor[]): Promise<StatementResult[]> {
    this.#store.checkProtocol(protocol);
    return this.#store.batch(statements);
  }

  async schemaState(protocol: number): Promise<SchemaState> {
    this.#store.checkProtocol(protocol);
    return this.#store.schemaState();
  }

  /** §4.4 step 2: the bookmark the Worker stores before anything changes. */
  async prepareMigration(protocol: number): Promise<{ bookmark: string; state: SchemaState }> {
    this.#store.checkProtocol(protocol);
    return { bookmark: await this.ctx.storage.getCurrentBookmark(), state: this.#store.schemaState() };
  }

  async applyMigrations(protocol: number, target: number, bookmarkId: string): Promise<SchemaState> {
    this.#store.checkProtocol(protocol);
    return this.#store.applyMigrations(target, bookmarkId);
  }

  async setRecovery(protocol: number, recovery: boolean): Promise<void> {
    this.#store.checkProtocol(protocol);
    this.#store.setRecovery(recovery);
  }

  /**
   * Operator recovery (§4.5), step one: arm a restore to `bookmark` for the
   * next start and hand back the undo bookmark. Nothing about the restore is
   * kept in this object's own storage — the restore rolls that back too; the
   * Worker records both bookmarks in `PLATFORM_DB` before calling `restart`.
   */
  async prepareRestore(protocol: number, bookmark: string): Promise<{ undo: string }> {
    this.#store.checkProtocol(protocol);
    return { undo: await this.ctx.storage.onNextSessionRestoreBookmark(bookmark) };
  }

  /** Step two: restart the object, which applies the armed restore. The call itself fails. */
  async restart(protocol: number): Promise<void> {
    this.#store.checkProtocol(protocol);
    this.ctx.abort();
  }

  /**
   * T-24: remember whose store this is and make sure an hourly alarm is
   * pending. Idempotent; the platform cron calls it for every active tenant.
   * The first run is spread over the hour so a fleet does not wake at once.
   */
  async armAlarm(protocol: number, tenantId: string): Promise<{ armed: boolean }> {
    this.#store.checkProtocol(protocol);
    // This object IS the tenant's store only if its id is the one the name
    // derives (getByName = idFromName): a caller cannot bind another tenant's
    // id to it, not even on the first call (T-24 review).
    const namespace = (this.env as { TENANT_STORE?: { idFromName(name: string): { equals(other: unknown): boolean } } })
      .TENANT_STORE;
    if (!namespace || !namespace.idFromName(tenantId).equals(this.ctx.id)) {
      throw new Error("TENANT_STORE_ID_MISMATCH");
    }
    const kv = this.ctx.storage.kv as StoreKv;
    const known = kv.get("tenant_id");
    if (known !== undefined && known !== tenantId) {
      // A store answers to one tenant for life; a different id is a routing bug.
      throw new Error("TENANT_STORE_ID_MISMATCH");
    }
    if (known === undefined) kv.put("tenant_id", tenantId);
    if ((await this.ctx.storage.getAlarm()) !== null) return { armed: false };
    await this.ctx.storage.setAlarm(Date.now() + Math.floor(Math.random() * TENANT_ALARM_INTERVAL_MS));
    return { armed: true };
  }

  /**
   * T-26 purge: drop the alarm and every row of this store. Bound to its own
   * tenant exactly as `armAlarm` is. Idempotent: an empty store purges again.
   */
  async purge(protocol: number, tenantId: string): Promise<void> {
    this.#store.checkProtocol(protocol);
    const namespace = (this.env as { TENANT_STORE?: { idFromName(name: string): { equals(other: unknown): boolean } } })
      .TENANT_STORE;
    if (!namespace || !namespace.idFromName(tenantId).equals(this.ctx.id)) {
      throw new Error("TENANT_STORE_ID_MISMATCH");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The engine read the ledger at start; the object restarts on next use with an empty one.
    this.ctx.abort("purged");
  }

  /** TEN-5: this tenant's housekeeping, in its own invocation (`tenant-alarm.ts`). */
  async alarm(): Promise<void> {
    const env = this.env as CloudflareRuntimeEnv;
    const tenantId = (this.ctx.storage.kv as StoreKv).get("tenant_id");
    // The store's own engine, without a hop: the same D1 shape the Worker sees.
    const local = {
      query: async (protocol: number, statement: StatementDescriptor, raw: boolean) => this.query(protocol, statement, raw),
      batch: async (protocol: number, statements: StatementDescriptor[]) => this.batch(protocol, statements),
    };
    await runTenantAlarm({
      tenantId: typeof tenantId === "string" ? tenantId : null,
      now: Date.now(),
      schemaState: () => this.#store.schemaState(),
      readTenant: (id) => readTenantRow(env.PLATFORM_DB as D1Database, id),
      maintain: async (id, scheduledTime, primaryHost, adSignalsPaused) => {
        const { runTenantMaintenance } = await import("./tenant-maintenance.ts");
        await runTenantMaintenance(
          env,
          // ADR-040: the alarm's handle carries the same tenant cipher as a request's.
          bindCredentials(createTenantDb(local), id, env as unknown as Record<string, unknown>),
          id,
          scheduledTime,
          { waitUntil: (task: Promise<unknown>) => this.ctx.waitUntil(task), passThroughOnException() {} } as never,
          primaryHost,
          adSignalsPaused,
        );
      },
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      recordHealth: async (id, outcome) => {
        let backlog: number | null = null;
        try {
          const result = this.#store.query({ sql: "SELECT COUNT(*) AS n FROM capi_event_outbox WHERE status = 'pending'", args: [] }, false);
          backlog = Number((result.results[0] as { n?: number } | undefined)?.n ?? 0);
        } catch {
          backlog = null;
        }
        await recordTenantHealth(env.PLATFORM_DB as D1Database, id, { ...outcome, backlog });
        // T-37: today's usage row exists for every running tenant, even on a quiet day.
        await recordUsage(env.PLATFORM_DB as D1Database, id, {});
      },
    });
  }
}
