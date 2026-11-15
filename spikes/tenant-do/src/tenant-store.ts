import type { DurableObjectState } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";

import {
  TENANT_STORE_PROTOCOL,
  applyMigrationFile,
  assertKnownPrefix,
  executeBatch,
  executeStatement,
  readLedger,
  type MigrationFile,
  type StatementDescriptor,
  type StatementResult,
  type StorageLike,
} from "./store-core.ts";

export type SchemaState = {
  applied: number;
  recovery: boolean;
  protocol: number;
};

/**
 * One tenant's database (ADR-039 Option D). The constructor only reads the
 * ledger; migrations run when the Worker asks, after it has stored a PITR
 * bookmark (`MULTI-TENANT-DESIGN.md` §4.4).
 */
export class TenantStore extends DurableObject {
  #applied: string[] = [];
  readonly #chain: readonly MigrationFile[];
  readonly #split: (sql: string) => string[];

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    chain: readonly MigrationFile[] = [],
    split: (sql: string) => string[] = (sql) => [sql],
  ) {
    super(ctx, env as never);
    this.#chain = chain;
    this.#split = split;
    void ctx.blockConcurrencyWhile(async () => {
      this.#applied = readLedger(this.#storage);
    });
  }

  get #storage(): StorageLike {
    return this.ctx.storage as unknown as StorageLike;
  }

  #protocol(protocol: number) {
    if (protocol !== TENANT_STORE_PROTOCOL) {
      throw new Error(`TENANT_STORE_PROTOCOL_MISMATCH: worker ${protocol}, store ${TENANT_STORE_PROTOCOL}`);
    }
  }

  get #recovery(): boolean {
    return this.ctx.storage.kv.get("recovery") === true;
  }

  async query(protocol: number, statement: StatementDescriptor, raw: boolean): Promise<StatementResult> {
    this.#protocol(protocol);
    return executeStatement(this.#storage, statement, raw);
  }

  async batch(protocol: number, statements: StatementDescriptor[]): Promise<StatementResult[]> {
    this.#protocol(protocol);
    return executeBatch(this.#storage, statements);
  }

  async schemaState(protocol: number): Promise<SchemaState> {
    this.#protocol(protocol);
    return { applied: this.#applied.length, recovery: this.#recovery, protocol: TENANT_STORE_PROTOCOL };
  }

  /** Step 2 of §4.4: the bookmark the Worker must store before anything changes. */
  async prepareMigration(protocol: number): Promise<{ bookmark: string; applied: number }> {
    this.#protocol(protocol);
    return { bookmark: await this.ctx.storage.getCurrentBookmark(), applied: this.#applied.length };
  }

  /**
   * Step 3 of §4.4. `bookmarkId` is the id of the row the Worker wrote first;
   * without it nothing runs. A file that fails leaves the store in `recovery`,
   * where no automatic migration runs again.
   */
  async applyMigrations(protocol: number, target: number, bookmarkId: string): Promise<SchemaState> {
    this.#protocol(protocol);
    if (!bookmarkId) throw new Error("TENANT_MIGRATION_NO_BOOKMARK");
    if (this.#recovery) throw new Error("TENANT_IN_RECOVERY");
    assertKnownPrefix(this.#applied, this.#chain);
    const goal = Math.min(target, this.#chain.length);
    while (this.#applied.length < goal) {
      const file = this.#chain[this.#applied.length];
      try {
        applyMigrationFile(this.#storage, file, this.#split);
      } catch (error) {
        this.ctx.storage.kv.put("recovery", true);
        throw new Error(`TENANT_MIGRATION_FAILED: ${file.name}: ${(error as Error).message}`);
      }
      this.#applied = [...this.#applied, file.name];
    }
    return { applied: this.#applied.length, recovery: false, protocol: TENANT_STORE_PROTOCOL };
  }

  /** Operator action (§4.5). The restarted object keeps its schema and stays in recovery. */
  async restore(protocol: number, bookmark: string): Promise<void> {
    this.#protocol(protocol);
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.ctx.storage.kv.put("restore_undo", undo);
    this.ctx.storage.kv.put("recovery", true);
    this.ctx.abort();
  }

  async setRecovery(protocol: number, recovery: boolean): Promise<void> {
    this.#protocol(protocol);
    if (recovery) this.ctx.storage.kv.put("recovery", true);
    else this.ctx.storage.kv.delete("recovery");
  }
}
