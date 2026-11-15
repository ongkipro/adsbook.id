import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import { BUNDLED_MIGRATIONS } from "../lib/bundled-migrations.ts";
import { splitMigrationStatements } from "../lib/schema-version.ts";
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
   * Operator recovery (§4.5): restore to a bookmark on the next start. The
   * restarted object keeps the restored schema and stays in recovery; the
   * call itself ends with the object aborting.
   */
  async restore(protocol: number, bookmark: string): Promise<void> {
    this.#store.checkProtocol(protocol);
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.#store.rememberRestoreUndo(undo);
    this.ctx.abort();
  }
}
