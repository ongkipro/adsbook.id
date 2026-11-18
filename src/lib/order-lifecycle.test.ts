import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import test from "node:test";
import {
  applyOrderLifecycleMutation,
  deleteOrdersReleasingReservations,
  OrderLifecycleError,
  releasesReservedStock,
  resolveAdminOrderTransition,
  updateAdminOrderShippingStatuses,
} from "./order-lifecycle.ts";
import type { OrderLifecycleState } from "./order-lifecycle.ts";

type TestOrder = OrderLifecycleState & {
  order_number: string;
  customer_name?: string;
  customer_phone?: string;
  provider_dispatch_claimed_at?: string | null;
  provider_dispatch_error?: string | null;
  receiver_rts_score?: number | null;
  rts_risk_label?: string | null;
  receiver_performance_json?: string | null;
  receiver_performance_checked_at?: string | null;
};
type TestItem = { order_id: number; variant_id: number; quantity: number };
type TestPayment = { order_id: number; reference_id: string };
type TestState = {
  orders: Map<number, TestOrder>;
  items: TestItem[];
  payments: TestPayment[];
  variants: Map<number, number>;
};

type StatementResult = {
  success: true;
  meta: { changes: number };
  results: unknown[];
};

const result = (changes = 0, results: unknown[] = []): StatementResult => ({
  success: true,
  meta: { changes },
  results,
});

function order(
  id: number,
  shippingStatus = "pending",
  overrides: Partial<TestOrder> = {},
): TestOrder {
  return {
    id,
    order_number: `INV-${10000 + id}`,
    payment_method: "cod",
    payment_status: "unpaid",
    shipping_status: shippingStatus,
    courier_code: null,
    cnote_no: null,
    provider_order_id: null,
    stock_restored_at: null,
    ...overrides,
  };
}

function cloneState(state: TestState): TestState {
  return {
    orders: new Map(
      Array.from(state.orders, ([id, value]) => [id, { ...value }]),
    ),
    items: state.items.map((item) => ({ ...item })),
    payments: state.payments.map((payment) => ({ ...payment })),
    variants: new Map(state.variants),
  };
}

class FakeStatement {
  readonly database: FakeD1Database;
  readonly sql: string;
  readonly args: unknown[];

  constructor(database: FakeD1Database, sql: string, args: unknown[] = []) {
    this.database = database;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new FakeStatement(this.database, this.sql, args);
  }

  async run() {
    return this.database.execute(this);
  }

  async all<T>() {
    const ids = this.args.map(Number);
    const rows = ids
      .map((id) => this.database.state.orders.get(id))
      .filter((value): value is TestOrder => Boolean(value))
      .map((value) => ({ ...value })) as T[];
    return { ...result(rows.length, rows), results: rows };
  }

  async first<T>() {
    if (this.sql.includes("FROM payment_reconciliation_audits")) return null;
    if (this.sql.includes("o.shipping_status = 'abandoned'")) {
      const lead = this.args
        .map((id) => this.database.state.orders.get(Number(id)))
        .find((order) => order?.shipping_status === "abandoned");
      return (lead ? { order_number: lead.order_number } : null) as T;
    }
    if (this.sql.includes("o.provider_order_id IS NOT NULL")) {
      const committed = this.args
        .map((id) => this.database.state.orders.get(Number(id)))
        .find(
          (order) =>
            order &&
            (["paid", "settled", "success"].includes(order.payment_status) ||
              Boolean(order.provider_order_id)),
        );
      return (committed ? { order_number: committed.order_number } : null) as T;
    }
    if (this.sql.includes("o.provider_dispatch_claimed_at IS NOT NULL")) {
      const inDoubt = this.args
        .map((id) => this.database.state.orders.get(Number(id)))
        .find(
          (order) =>
            order &&
            (Boolean(order.provider_dispatch_claimed_at) ||
              order.provider_dispatch_error === "DISPATCHING" ||
              Boolean(order.provider_dispatch_error?.startsWith("DISPATCH_UNKNOWN:"))),
        );
      return (inDoubt ? { order_number: inDoubt.order_number } : null) as T;
    }
    const numericArgs = this.args
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    const id = numericArgs.at(-1);
    const value = id == null ? undefined : this.database.state.orders.get(id);
    if (!value) return null;
    return {
      ...value,
      warehouse_id: null,
      pickup_schedule_id: null,
      customer_name: value.customer_name ?? "Customer",
      customer_phone: value.customer_phone ?? "081234567890",
      address: "Jalan Pengujian Nomor 1",
      province: "Sumatera Utara",
      city: "Medan",
      district: "Medan Kota",
      postal_code: "20111",
      destination_area_id: "area-1",
      total_amount: 100000,
      shipping_cost: 10000,
      discount_amount: 0,
      cod_service_fee: 0,
      cod_service_fee_vat: 0,
      cod_fee_bearer: "buyer",
      confirmed_at: null,
      courier_service: null,
      provider_dispatch_error: value.provider_dispatch_error ?? null,
      provider_dispatch_claimed_at: value.provider_dispatch_claimed_at ?? null,
      receiver_delivery_rate: value.receiver_rts_score ?? null,
      receiver_risk_label: value.rts_risk_label ?? null,
      receiver_performance_json: value.receiver_performance_json ?? null,
      receiver_performance_checked_at: value.receiver_performance_checked_at ?? null,
      ad_click_ids: null,
      created_at: "2026-08-17T00:00:00.000Z",
      warehouse_name: null,
      pickup_address_id: null,
      pickup_scheduled_at: null,
      pickup_status: null,
    } as T;
  }
}

class FakeD1Database {
  state: TestState;
  failOnSql: string | null = null;
  beforeCustomerUpdate: ((order: TestOrder) => void) | null = null;
  /** Runs once, between a request's reads and its write batch. */
  beforeNextBatch: (() => void | Promise<void>) | null = null;

  constructor(state: TestState) {
    this.state = cloneState(state);
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    const interleave = this.beforeNextBatch;
    this.beforeNextBatch = null;
    await interleave?.();
    const before = cloneState(this.state);
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await this.execute(statement as unknown as FakeStatement));
      }
      return results as D1Result<unknown>[];
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  async execute(statement: FakeStatement): Promise<StatementResult> {
    const { sql, args } = statement;
    if (this.failOnSql && sql.includes(this.failOnSql)) {
      throw new Error("injected D1 statement failure");
    }
    const ids = args.map(Number).filter((id) => Number.isInteger(id) && id > 0);
    // The single-order write is bound to the state it was validated against:
    // `... WHERE id = ? AND payment_method = ? AND payment_status = ? AND shipping_status = ?`.
    const stateGuarded = sql.includes("AND payment_method = ? AND payment_status = ? AND shipping_status = ?");
    const guardedTargetId = Number(args.at(stateGuarded ? -4 : -1));
    const stateMoved = (current: TestOrder) =>
      stateGuarded &&
      (current.payment_method !== args.at(-3) ||
        current.payment_status !== args.at(-2) ||
        current.shipping_status !== args.at(-1));

    if (sql.includes("UPDATE product_variants")) {
      const releaseStateRequired = sql.includes("o.shipping_status IN");
      const excludesAbandoned = sql.includes("o.shipping_status <> 'abandoned'");
      const quantities = new Map<number, number>();
      for (const id of ids) {
        const current = this.state.orders.get(id);
        if (!current || current.stock_restored_at) continue;
        if (excludesAbandoned && current.shipping_status === "abandoned") continue;
        if (
          releaseStateRequired &&
          !releasesReservedStock(
            current.payment_status,
            current.shipping_status,
          )
        ) {
          continue;
        }
        for (const item of this.state.items.filter((row) => row.order_id === id)) {
          quantities.set(
            item.variant_id,
            (quantities.get(item.variant_id) || 0) + item.quantity,
          );
        }
      }
      let changes = 0;
      for (const [variantId, quantity] of quantities) {
        const stock = this.state.variants.get(variantId);
        if (stock == null) continue;
        this.state.variants.set(variantId, stock + quantity);
        changes += 1;
      }
      return result(changes);
    }

    if (
      sql.includes("UPDATE orders") &&
      (sql.includes("customer_phone = ?") || sql.includes("customer_name = ?"))
    ) {
      const current = this.state.orders.get(guardedTargetId);
      if (!current) return result();
      this.beforeCustomerUpdate?.(current);
      if (stateMoved(current)) return result();
      if (
        sql.includes("provider_order_id IS NULL") &&
        (current.provider_order_id ||
          current.provider_dispatch_claimed_at ||
          current.shipping_status !== "pending")
      ) {
        return result();
      }
      const setClause = sql.match(/SET([\s\S]+?)WHERE/i)?.[1] || "";
      const columns = setClause
        .split(",")
        .map((entry) => entry.match(/^\s*([a-z_]+)\s*=\s*\?/i)?.[1])
        .filter((value): value is string => Boolean(value));
      columns.forEach((column, index) => {
        (current as unknown as Record<string, unknown>)[column] = args[index];
      });
      return result(1);
    }

    if (sql.includes("UPDATE orders AS o") && sql.includes("stock_restored_at")) {
      const releaseStateRequired = sql.includes("o.shipping_status IN");
      const excludesAbandoned = sql.includes("o.shipping_status <> 'abandoned'");
      let changes = 0;
      for (const id of ids) {
        const current = this.state.orders.get(id);
        if (!current || current.stock_restored_at) continue;
        if (excludesAbandoned && current.shipping_status === "abandoned") continue;
        if (
          releaseStateRequired &&
          !releasesReservedStock(
            current.payment_status,
            current.shipping_status,
          )
        ) {
          continue;
        }
        current.stock_restored_at = "2026-08-17T00:00:00.000Z";
        changes += 1;
      }
      return result(changes);
    }

    if (sql.includes("UPDATE orders") && sql.includes("json_each")) {
      // The bulk write: each order only while it is still in its validated state.
      const status = sql.match(/SET shipping_status = '([^']+)'/)?.[1] || "";
      const updated = [];
      for (const [id, paymentMethod, paymentStatus, shippingStatus] of JSON.parse(String(args[0])) as [number, string, string, string][]) {
        const current = this.state.orders.get(id);
        if (
          !current ||
          current.payment_method !== paymentMethod ||
          current.payment_status !== paymentStatus ||
          current.shipping_status !== shippingStatus
        ) continue;
        current.shipping_status = status;
        updated.push({ id });
      }
      return result(updated.length, updated);
    }

    if (sql.includes("UPDATE orders") && sql.includes("shipping_status")) {
      const current = this.state.orders.get(guardedTargetId);
      if (!current || stateMoved(current)) return result();
      const setClause = sql.match(/SET([\s\S]+?)WHERE/i)?.[1] || "";
      setClause
        .split(",")
        .map((entry) => entry.match(/^\s*([a-z_]+)\s*=\s*\?/i)?.[1])
        .forEach((column, index) => {
          if (column) (current as unknown as Record<string, unknown>)[column] = args[index];
        });
      return result(1);
    }

    if (sql.includes("DELETE FROM order_items")) {
      const before = this.state.items.length;
      this.state.items = this.state.items.filter((item) => !ids.includes(item.order_id));
      return result(before - this.state.items.length);
    }

    if (sql.includes("DELETE FROM payment_transactions")) {
      const orderNumbers = new Set(
        ids
          .map((id) => this.state.orders.get(id)?.order_number)
          .filter((value): value is string => Boolean(value)),
      );
      const before = this.state.payments.length;
      this.state.payments = this.state.payments.filter(
        (payment) =>
          !ids.includes(payment.order_id) &&
          !orderNumbers.has(payment.reference_id),
      );
      return result(before - this.state.payments.length);
    }

    if (sql.includes("DELETE FROM orders")) {
      const deleted = [];
      for (const id of ids) {
        const current = this.state.orders.get(id);
        if (!current) continue;
        deleted.push({ id: current.id, order_number: current.order_number });
        this.state.orders.delete(id);
      }
      return result(deleted.length, deleted);
    }

    throw new Error(`Unhandled test SQL: ${sql}`);
  }
}

type SqlValue = null | number | string | Uint8Array;

class SqliteStatement {
  readonly database: DatabaseSync;
  readonly sql: string;
  readonly values: SqlValue[];

  constructor(database: DatabaseSync, sql: string, values: SqlValue[] = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: SqlValue[]) {
    return new SqliteStatement(this.database, this.sql, values);
  }

  async first<T>() {
    return (this.prepare().get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.prepare().all(...this.values) as T[] };
  }

  execute() {
    const statement = this.prepare();
    if (/\bRETURNING\b/i.test(this.sql)) {
      const rows = statement.all(...this.values) as Record<string, unknown>[];
      return result(rows.length, rows);
    }
    const execution = statement.run(...this.values);
    return result(Number(execution.changes));
  }

  prepare(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE product_variants (
        id INTEGER PRIMARY KEY,
        stock INTEGER
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        order_number TEXT NOT NULL UNIQUE,
        payment_method TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        shipping_status TEXT NOT NULL,
        courier_code TEXT,
        cnote_no TEXT,
        provider_order_id TEXT,
        provider_dispatch_error TEXT,
        provider_dispatch_claimed_at TEXT,
        stock_restored_at TEXT,
        fulfillment_type TEXT NOT NULL DEFAULT 'physical'
      );
      CREATE TABLE order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        variant_id INTEGER NOT NULL REFERENCES product_variants(id),
        quantity INTEGER NOT NULL
      );
      CREATE TABLE payment_transactions (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        reference_id TEXT NOT NULL
      );
      CREATE TABLE payment_reconciliation_audits (
        payment_transaction_id INTEGER NOT NULL UNIQUE
      );
    `);
  }

  prepare(sql: string) {
    return new SqliteStatement(this.database, sql) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteStatement).execute(),
      );
      this.database.exec("COMMIT");
      return results as D1Result<unknown>[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  get<T>(sql: string) {
    return this.database.prepare(sql).get() as T | undefined;
  }
}

function databaseWithOrders(...orders: TestOrder[]) {
  return new FakeD1Database({
    orders: new Map(orders.map((value) => [value.id, value])),
    items: orders.map((value) => ({
      order_id: value.id,
      variant_id: 501,
      quantity: value.id,
    })),
    payments: orders.map((value) => ({
      order_id: value.id,
      reference_id: value.order_number,
    })),
    variants: new Map([[501, 10]]),
  });
}

const extensionResolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelativeWithoutExtension =
        specifier.startsWith(".") && !/\.[a-z0-9]+$/i.test(specifier);
      if (!isRelativeWithoutExtension) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
const detailRoute = await import("../pages/api/admin/orders/[id].ts");
const bulkRoute = await import("../pages/api/admin/orders/index.ts");
extensionResolver.deregister();

function locals(database: FakeD1Database) {
  return {
    admin: { id: "admin-1", role: "owner" },
    tenantDb: database as unknown as D1Database, runtimeEnv: { OMS_DB: database as unknown as D1Database},
  };
}

test("canonical policy preserves dispatch, payment, waybill, and stock guards", () => {
  const pending = order(1);
  assert.deepEqual(resolveAdminOrderTransition(pending, { shippingStatus: "cancelled" }), {
    paymentStatus: "unpaid",
    shippingStatus: "cancelled",
    releasesStock: true,
  });

  const dispatched = order(2, "processing", {
    provider_order_id: "provider-2",
    courier_code: "jne",
    cnote_no: "WAYBILL-2",
  });
  assert.equal(
    resolveAdminOrderTransition(dispatched, { shippingStatus: "shipped" })
      .shippingStatus,
    "shipped",
  );

  assert.throws(
    () => resolveAdminOrderTransition(pending, { shippingStatus: "processing" }),
    /Push\/Arrange Shipping/,
  );
  assert.throws(
    () =>
      resolveAdminOrderTransition(
        order(3, "processing", { provider_order_id: "provider-3" }),
        { shippingStatus: "shipped" },
      ),
    /kurir, dan nomor resi/,
  );
  assert.throws(
    () =>
      resolveAdminOrderTransition(
        order(4, "processing", {
          payment_method: "bank_transfer",
          provider_order_id: "provider-4",
          courier_code: "jne",
          cnote_no: "WAYBILL-4",
        }),
        { shippingStatus: "delivered" },
      ),
    /sebelum berstatus paid/,
  );
  for (const paidStatus of ["paid", "settled", "success"]) {
    assert.throws(
      () =>
        resolveAdminOrderTransition(
          order(5, "pending", { payment_method: "bank_transfer" }),
          { paymentStatus: paidStatus },
        ),
      /rekonsiliasi AutoLaris/,
    );
  }
  // A manual transfer lands in the seller's own account; only the operator can
  // confirm it, so the lifecycle must let them — otherwise it can never ship.
  assert.equal(
    resolveAdminOrderTransition(order(5, "pending", { payment_method: "manual_transfer" }), {
      paymentStatus: "paid",
    }).paymentStatus,
    "paid",
  );

  for (const terminalStatus of ["cancelled", "returned"] as const) {
    assert.throws(
      () =>
        resolveAdminOrderTransition(order(6, terminalStatus), {
          shippingStatus: "processing",
        }),
      /tidak dapat diaktifkan kembali/,
    );
  }
  assert.throws(
    () =>
      resolveAdminOrderTransition(order(6, "returned"), {
        paymentStatus: "refunded",
        shippingStatus: "processing",
      }),
    /tidak dapat diaktifkan kembali/,
  );
  assert.throws(
    () =>
      resolveAdminOrderTransition(
        order(7, "processing", {
          provider_order_id: "provider-7",
          stock_restored_at: "2026-08-17T00:00:00.000Z",
        }),
        { shippingStatus: "shipped" },
      ),
    /tidak dapat diaktifkan kembali/,
  );
});

test("detail and bulk status routes share the terminal-state rejection", async () => {
  const detailDatabase = databaseWithOrders(order(11, "cancelled"));
  const detailResponse = await detailRoute.PATCH({
    params: { id: "11" },
    request: new Request("https://example.test/api/admin/orders/11", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shipping_status: "processing" }),
    }),
    locals: locals(detailDatabase),
  } as never);
  assert.equal(detailResponse.status, 409);
  assert.equal(detailDatabase.state.orders.get(11)?.shipping_status, "cancelled");

  const bulkDatabase = databaseWithOrders(
    order(12, "processing", {
      provider_order_id: "provider-12",
      courier_code: "jne",
      cnote_no: "WAYBILL-12",
    }),
    order(13, "returned", {
      provider_order_id: "provider-13",
      courier_code: "jne",
      cnote_no: "WAYBILL-13",
    }),
  );
  const bulkResponse = await bulkRoute.POST({
    request: new Request("https://example.test/api/admin/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_ids: ["12", "13"], status: "shipped" }),
    }),
    locals: locals(bulkDatabase),
  } as never);
  assert.equal(bulkResponse.status, 409);
  assert.equal(bulkDatabase.state.orders.get(12)?.shipping_status, "processing");
  assert.equal(bulkDatabase.state.orders.get(13)?.shipping_status, "returned");
});

test("detail cancellation releases the order exactly once", async () => {
  const database = databaseWithOrders(order(14));
  const invoke = () =>
    detailRoute.PATCH({
      params: { id: "14" },
      request: new Request("https://example.test/api/admin/orders/14", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shipping_status: "cancelled" }),
      }),
      locals: locals(database),
    } as never);

  const first = await invoke();
  assert.equal(first.status, 200);
  assert.equal(database.state.orders.get(14)?.shipping_status, "cancelled");
  // The release marker is what must be exactly-once; the stock figure is not
  // touched at all any more (ADR-023).
  const releasedAt = database.state.orders.get(14)?.stock_restored_at;
  assert.ok(releasedAt);
  assert.equal(database.state.variants.get(501), 10);

  const repeat = await invoke();
  assert.equal(repeat.status, 200);
  assert.equal(database.state.orders.get(14)?.stock_restored_at, releasedAt);
  assert.equal(database.state.variants.get(501), 10);
});

test("editing a customer phone invalidates receiver scoring before refresh", async () => {
  const database = databaseWithOrders(order(15, "pending", {
    customer_phone: "081234567890",
    receiver_rts_score: 92,
    rts_risk_label: "LOW",
    receiver_performance_json: JSON.stringify({ deliveryRate: 92 }),
    receiver_performance_checked_at: "2026-08-17T00:00:00.000Z",
  }));
  const response = await detailRoute.PATCH({
    params: { id: "15" },
    request: new Request("https://example.test/api/admin/orders/15", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_phone: "081298765432" }),
    }),
    locals: locals(database),
  } as never);
  const payload = await response.json() as {
    data: {
      customer_phone: string;
      receiver_delivery_rate: number | null;
      receiver_risk_label: string | null;
      receiver_performance: unknown;
      receiver_performance_checked_at: string | null;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(payload.data.customer_phone, "6281298765432");
  assert.equal(payload.data.receiver_delivery_rate, null);
  assert.equal(payload.data.receiver_risk_label, null);
  assert.equal(payload.data.receiver_performance, null);
  assert.equal(payload.data.receiver_performance_checked_at, null);
});

test("a buyer edit loses atomically when Mengantar dispatch claims the order", async () => {
  const database = databaseWithOrders(order(16, "pending", {
    customer_name: "Customer",
    customer_phone: "081234567890",
  }));
  database.beforeCustomerUpdate = (current) => {
    current.provider_dispatch_claimed_at = "2026-08-18T00:00:00.000Z";
  };

  const response = await detailRoute.PATCH({
    params: { id: "16" },
    request: new Request("https://example.test/api/admin/orders/16", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer_name: "Changed after claim" }),
    }),
    locals: locals(database),
  } as never);
  const payload = await response.json() as { error?: string };

  assert.equal(response.status, 409);
  assert.match(payload.error || "", /sedang atau sudah diproses ke Mengantar/);
  assert.equal(database.state.orders.get(16)?.customer_name, "Customer");
});

test("changing a destination cannot retain a stale courier quote", async () => {
  const database = databaseWithOrders(order(17));
  const response = await detailRoute.PATCH({
    params: { id: "17" },
    request: new Request("https://example.test/api/admin/orders/17", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination_area_id: "area-2" }),
    }),
    locals: locals(database),
  } as never);

  assert.equal(response.status, 422);
  assert.equal(database.state.orders.get(17)?.shipping_status, "pending");
});

test("bulk cancellation releases once across repeat attempts", async () => {
  const database = databaseWithOrders(order(21), order(22));
  assert.deepEqual(
    await updateAdminOrderShippingStatuses(
      database as unknown as D1Database,
      [21, 22],
      "cancelled",
    ),
    { updatedIds: [21, 22], conflictIds: [] },
  );
  const released = [21, 22].map((id) => database.state.orders.get(id)?.stock_restored_at);
  assert.ok(released.every(Boolean));
  assert.equal(database.state.variants.get(501), 10);

  assert.deepEqual(
    await updateAdminOrderShippingStatuses(
      database as unknown as D1Database,
      [21, 22],
      "cancelled",
    ),
    { updatedIds: [21, 22], conflictIds: [] },
  );
  assert.deepEqual(
    [21, 22].map((id) => database.state.orders.get(id)?.stock_restored_at),
    released,
  );
  assert.equal(database.state.variants.get(501), 10);
});

test("single delete route deletes once and a repeat is a 404", async () => {
  const database = databaseWithOrders(order(31));
  const invoke = () =>
    detailRoute.DELETE({
      params: { id: "31" },
      locals: locals(database),
    } as never);

  const first = await invoke();
  assert.equal(first.status, 200);
  assert.equal(database.state.variants.get(501), 10);
  assert.equal(database.state.orders.size, 0);
  assert.equal(database.state.items.length, 0);
  assert.equal(database.state.payments.length, 0);

  const repeat = await invoke();
  assert.equal(repeat.status, 404);
  assert.equal(database.state.variants.get(501), 10);
});

test("a lead cannot be deleted through the order route (owner 2026-11-10)", async () => {
  const database = databaseWithOrders(order(32, "abandoned"));
  const stockBefore = database.state.variants.get(501);

  const response = await detailRoute.DELETE({
    params: { id: "32" },
    locals: locals(database),
  } as never);

  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /lead dan tidak pernah dihapus/);
  assert.equal(database.state.variants.get(501), stockBefore);
  assert.equal(database.state.orders.has(32), true);
});

test("bulk delete route reports the orders it actually deleted", async () => {
  const database = databaseWithOrders(
    order(41),
    order(42, "cancelled", {
      stock_restored_at: "2026-08-16T00:00:00.000Z",
    }),
  );
  const response = await bulkRoute.DELETE({
    request: new Request("https://example.test/api/admin/orders", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [41, 42, 999] }),
    }),
    locals: locals(database),
  } as never);
  const payload = (await response.json()) as {
    deleted_count: number;
    deleted_ids: number[];
  };

  assert.equal(response.status, 200);
  assert.equal(database.state.variants.get(501), 10);
  assert.equal(database.state.orders.size, 0);
  assert.deepEqual(payload.deleted_ids.sort((a, b) => a - b), [41, 42]);
  assert.equal(payload.deleted_count, 2);
});

for (const [name, invoke] of [
  [
    "single",
    async (database: FakeD1Database) =>
      detailRoute.DELETE({
        params: { id: "51" },
        locals: locals(database),
      } as never),
  ],
  [
    "bulk",
    async (database: FakeD1Database) =>
      bulkRoute.DELETE({
        request: new Request("https://example.test/api/admin/orders", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [51] }),
        }),
        locals: locals(database),
      } as never),
  ],
] as const) {
  test(`${name} delete rolls stock restoration back when a later delete fails`, async () => {
    const database = databaseWithOrders(order(51));
    database.failOnSql = "DELETE FROM payment_transactions";

    const response = await invoke(database);
    assert.equal(response.status, 500);
    assert.equal(database.state.variants.get(501), 10);
    assert.equal(database.state.orders.size, 1);
    assert.equal(database.state.items.length, 1);
    assert.equal(database.state.payments.length, 1);
    assert.equal(database.state.orders.get(51)?.stock_restored_at, null);
  });
}

test("canonical delete helper returns no rows on a repeat attempt", async () => {
  const database = databaseWithOrders(order(61));
  const first = await deleteOrdersReleasingReservations(
    database as unknown as D1Database,
    [61],
  );
  const repeat = await deleteOrdersReleasingReservations(
    database as unknown as D1Database,
    [61],
  );
  assert.deepEqual(first, [{ id: 61, order_number: "INV-10061" }]);
  assert.deepEqual(repeat, []);
  assert.equal(database.state.variants.get(501), 10);
});

test("delete SQL rolls back atomically on a real SQLite engine", async () => {
  const successful = new SqliteD1Database();
  successful.exec(`
    INSERT INTO product_variants (id, stock) VALUES (501, 10);
    INSERT INTO orders (
      id, order_number, payment_method, payment_status, shipping_status
    ) VALUES (81, 'INV-10081', 'cod', 'unpaid', 'pending');
    INSERT INTO order_items (order_id, variant_id, quantity)
      VALUES (81, 501, 3);
    INSERT INTO payment_transactions (order_id, reference_id)
      VALUES (81, 'INV-10081');
  `);
  const deleted = await deleteOrdersReleasingReservations(
    successful as unknown as D1Database,
    [81],
  );
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.id, 81);
  assert.equal(deleted[0]?.order_number, "INV-10081");
  // Untouched: deleting an order no longer moves a stock figure (ADR-023).
  assert.equal(
    successful.get<{ stock: number }>(
      "SELECT stock FROM product_variants WHERE id = 501",
    )?.stock,
    10,
  );
  assert.equal(
    successful.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM orders",
    )?.count,
    0,
  );

  const failing = new SqliteD1Database();
  failing.exec(`
    INSERT INTO product_variants (id, stock) VALUES (501, 10);
    INSERT INTO orders (
      id, order_number, payment_method, payment_status, shipping_status
    ) VALUES (82, 'INV-10082', 'cod', 'unpaid', 'pending');
    INSERT INTO order_items (order_id, variant_id, quantity)
      VALUES (82, 501, 4);
    INSERT INTO payment_transactions (order_id, reference_id)
      VALUES (82, 'INV-10082');
    CREATE TRIGGER reject_payment_delete
    BEFORE DELETE ON payment_transactions
    BEGIN
      SELECT RAISE(ABORT, 'injected payment delete failure');
    END;
  `);
  await assert.rejects(
    deleteOrdersReleasingReservations(failing as unknown as D1Database, [82]),
    /injected payment delete failure/,
  );
  assert.equal(
    failing.get<{ stock: number }>(
      "SELECT stock FROM product_variants WHERE id = 501",
    )?.stock,
    10,
  );
  assert.equal(
    failing.get<{ stock_restored_at: string | null }>(
      "SELECT stock_restored_at FROM orders WHERE id = 82",
    )?.stock_restored_at,
    null,
  );
  assert.equal(
    failing.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM order_items WHERE order_id = 82",
    )?.count,
    1,
  );
  assert.equal(
    failing.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM payment_transactions WHERE order_id = 82",
    )?.count,
    1,
  );
});

test("single and bulk delete reject audited payments before restoring stock", async () => {
  const database = new SqliteD1Database();
  database.exec(`
    INSERT INTO product_variants (id, stock) VALUES (501, 10);
    INSERT INTO orders (
      id, order_number, payment_method, payment_status, shipping_status
    ) VALUES
      (83, 'INV-10083', 'qris', 'paid', 'pending'),
      (84, 'INV-10084', 'cod', 'unpaid', 'pending');
    INSERT INTO order_items (order_id, variant_id, quantity) VALUES
      (83, 501, 2), (84, 501, 3);
    INSERT INTO payment_transactions (id, order_id, reference_id) VALUES
      (183, 83, 'INV-10083'), (184, 84, 'INV-10084');
    INSERT INTO payment_reconciliation_audits (payment_transaction_id)
      VALUES (183);
  `);

  for (const ids of [[83], [83, 84]]) {
    await assert.rejects(
      deleteOrdersReleasingReservations(database as unknown as D1Database, ids),
      (error: unknown) =>
        error instanceof OrderLifecycleError && error.status === 409,
    );
    assert.equal(
      database.get<{ stock: number }>(
        "SELECT stock FROM product_variants WHERE id = 501",
      )?.stock,
      10,
    );
    assert.equal(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM orders WHERE id IN (83, 84)",
      )?.count,
      2,
    );
    assert.equal(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM order_items WHERE order_id IN (83, 84)",
      )?.count,
      2,
    );
  }
});

test("lifecycle mutation and release are atomic on D1 batch failure", async () => {
  const current = order(71);
  const database = databaseWithOrders(current);
  // The release marker is the statement the batch now depends on.
  database.failOnSql = "SET stock_restored_at";

  await assert.rejects(
    applyOrderLifecycleMutation(
      database as unknown as D1Database,
      current,
      { shippingStatus: "cancelled" },
      database
        .prepare("UPDATE orders SET shipping_status = ? WHERE id = ?")
        .bind("cancelled", 71),
    ),
    (error: unknown) =>
      error instanceof Error && error.message === "injected D1 statement failure",
  );
  assert.equal(database.state.orders.get(71)?.shipping_status, "pending");
  assert.equal(database.state.orders.get(71)?.stock_restored_at, null);
  assert.equal(database.state.variants.get(501), 10);
});

test("lifecycle errors retain route-safe status codes", async () => {
  await assert.rejects(
    updateAdminOrderShippingStatuses(
      databaseWithOrders() as unknown as D1Database,
      [],
      "pending",
    ),
    (error: unknown) =>
      error instanceof OrderLifecycleError && error.status === 400,
  );
});

test("an order paid by the provider check or already with the courier cannot be deleted", async () => {
  const database = new SqliteD1Database();
  database.exec(`
    INSERT INTO orders (
      id, order_number, payment_method, payment_status, shipping_status, provider_order_id
    ) VALUES
      (91, 'INV-10091', 'qris', 'paid', 'pending', NULL),
      (92, 'INV-10092', 'cod', 'unpaid', 'processing', 'MGN-92'),
      (93, 'INV-10093', 'cod', 'unpaid', 'pending', NULL);
  `);
  for (const ids of [[91], [92], [93, 92]]) {
    await assert.rejects(
      deleteOrdersReleasingReservations(database as unknown as D1Database, ids),
      (error: unknown) => error instanceof OrderLifecycleError && error.status === 409,
    );
  }
  const deleted = await deleteOrdersReleasingReservations(database as unknown as D1Database, [93]);
  assert.deepEqual(deleted.map((row) => row.order_number), ["INV-10093"]);
});

// ── PR-4: no delete while Mengantar may hold the shipment ───────────────────

const DISPATCH_FIXTURE = `
  INSERT INTO product_variants (id, stock) VALUES (501, 10);
  INSERT INTO orders (
    id, order_number, payment_method, payment_status, shipping_status,
    provider_dispatch_error, provider_dispatch_claimed_at
  ) VALUES
    (101, 'INV-10101', 'cod', 'unpaid', 'pending', 'DISPATCHING', '2026-11-16T03:00:00.000Z'),
    (102, 'INV-10102', 'cod', 'unpaid', 'pending', 'DISPATCH_UNKNOWN: koneksi terputus', NULL),
    (103, 'INV-10103', 'cod', 'unpaid', 'pending', 'Kredensial Mengantar belum lengkap.', NULL),
    (104, 'INV-10104', 'cod', 'unpaid', 'pending', NULL, NULL);
  INSERT INTO order_items (order_id, variant_id, quantity) VALUES
    (101, 501, 1), (102, 501, 1), (103, 501, 1), (104, 501, 1);
  INSERT INTO payment_transactions (order_id, reference_id) VALUES
    (101, 'INV-10101'), (102, 'INV-10102'), (103, 'INV-10103'), (104, 'INV-10104');
`;

/** What deletion would remove, and the void marker it must not leave behind. */
const ownedRows = (database: SqliteD1Database, id: number) =>
  ({
    ...database.get<Record<string, unknown>>(
      `SELECT (SELECT COUNT(*) FROM orders WHERE id = ${id}) AS orders,
        (SELECT COUNT(*) FROM order_items WHERE order_id = ${id}) AS items,
        (SELECT COUNT(*) FROM payment_transactions WHERE order_id = ${id}) AS payments,
        (SELECT stock_restored_at FROM orders WHERE id = ${id}) AS voided`,
    ),
  });
const INTACT = { orders: 1, items: 1, payments: 1, voided: null };
const refusedAsConflict = (error: unknown) =>
  error instanceof OrderLifecycleError && error.status === 409 && /Mengantar/.test(error.message);

test("an order with a dispatch claim or an unknown dispatch outcome cannot be deleted", async () => {
  const database = new SqliteD1Database();
  database.exec(DISPATCH_FIXTURE);
  const d1 = database as unknown as D1Database;

  // Claimed (101), unknown outcome with no provider id (102), and either one
  // inside a selection that is otherwise deletable: the whole request refuses.
  for (const ids of [[101], [102], [104, 101], [104, 102]]) {
    await assert.rejects(deleteOrdersReleasingReservations(d1, ids), refusedAsConflict);
    for (const id of ids) assert.deepEqual(ownedRows(database, id), INTACT, `order ${id}`);
  }

  // A push that failed outright released its claim: nothing is with Mengantar.
  const deleted = await deleteOrdersReleasingReservations(d1, [103, 104]);
  assert.deepEqual(deleted.map((row) => row.id).sort(), [103, 104]);
  assert.deepEqual(ownedRows(database, 104), { orders: 0, items: 0, payments: 0, voided: null });
});

for (const [name, lateWrite] of [
  ["claims the order", "UPDATE orders SET provider_dispatch_error = 'DISPATCHING', provider_dispatch_claimed_at = '2026-11-16T03:00:00.000Z' WHERE id = 104"],
  ["leaves an unknown outcome", "UPDATE orders SET provider_dispatch_error = 'DISPATCH_UNKNOWN: timeout' WHERE id = 104"],
  ["finishes and records the shipment", "UPDATE orders SET provider_order_id = 'MGN-104', shipping_status = 'processing' WHERE id = 104"],
  ["is preceded by a payment", "UPDATE orders SET payment_status = 'paid' WHERE id = 104"],
] as const) {
  test(`delete is refused when a push ${name} after deletion's reads`, async () => {
    const database = new SqliteD1Database();
    database.exec(DISPATCH_FIXTURE);
    // Deletion has read 103 and 104 as deletable; the write lands before its batch.
    const racing = {
      prepare: (sql: string) => database.prepare(sql),
      batch(statements: D1PreparedStatement[]) {
        database.exec(lateWrite);
        return database.batch(statements);
      },
    } as unknown as D1Database;

    await assert.rejects(
      deleteOrdersReleasingReservations(racing, [103, 104]),
      (error: unknown) => error instanceof OrderLifecycleError && error.status === 409,
    );
    assert.deepEqual(ownedRows(database, 104), INTACT);
    assert.deepEqual(ownedRows(database, 103), INTACT, "all or nothing: the deletable sibling stays too");
  });
}

test("a refusal whose cause is gone by the re-read is still a conflict, not a missing order", async () => {
  const database = new SqliteD1Database();
  database.exec(DISPATCH_FIXTURE);
  // The push claims 104 before the batch, then fails and releases the claim
  // before deletion can ask why nothing was deleted.
  const racing = {
    prepare: (sql: string) => database.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      database.exec("UPDATE orders SET provider_dispatch_error = 'DISPATCHING', provider_dispatch_claimed_at = '2026-11-16T03:00:00.000Z' WHERE id = 104");
      const results = await database.batch(statements);
      database.exec("UPDATE orders SET provider_dispatch_error = 'Kurir menolak.', provider_dispatch_claimed_at = NULL WHERE id = 104");
      return results;
    },
  } as unknown as D1Database;

  await assert.rejects(
    deleteOrdersReleasingReservations(racing, [104]),
    (error: unknown) => error instanceof OrderLifecycleError && error.status === 409,
  );
  assert.deepEqual(ownedRows(database, 104), INTACT);
});

test("the delete routes answer 409 for a claimed order and keep it", async () => {
  const claimed = () =>
    databaseWithOrders(
      order(111, "pending", {
        provider_dispatch_error: "DISPATCHING",
        provider_dispatch_claimed_at: "2026-11-16T03:00:00.000Z",
      }),
    );
  const single = claimed();
  const bulk = claimed();
  const responses = [
    await detailRoute.DELETE({ params: { id: "111" }, locals: locals(single) } as never),
    await bulkRoute.DELETE({
      request: new Request("https://example.test/api/admin/orders", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [111] }),
      }),
      locals: locals(bulk),
    } as never),
  ];
  for (const response of responses) {
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /Mengantar/);
  }
  assert.equal(single.state.orders.has(111), true);
  assert.equal(bulk.state.orders.has(111), true);
  assert.equal(single.state.items.length, 1);
});

// ── PR-7: an admin status write lands only on the state it was validated against ──

const shippedOrder = (id: number, overrides: Partial<TestOrder> = {}) =>
  order(id, "processing", {
    provider_order_id: `provider-${id}`,
    courier_code: "jne",
    cnote_no: `WAYBILL-${id}`,
    ...overrides,
  });

const patchStatus = (database: FakeD1Database, id: number, shippingStatus: string) =>
  detailRoute.PATCH({
    params: { id: String(id) },
    request: new Request(`https://example.test/api/admin/orders/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shipping_status: shippingStatus }),
    }),
    locals: locals(database),
  } as never);

const bulkStatus = (database: FakeD1Database, ids: number[], status: string) =>
  bulkRoute.POST({
    request: new Request("https://example.test/api/admin/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_ids: ids.map(String), status }),
    }),
    locals: locals(database),
  } as never);

test("two status changes validated against one processing order: the second answers 409 and the first stays", async () => {
  const database = databaseWithOrders(shippedOrder(121));
  // `delivered` has read and validated the order as processing when `returned`
  // is applied in full; only then does `delivered` reach its write.
  let returned: Response | undefined;
  database.beforeNextBatch = async () => {
    returned = await patchStatus(database, 121, "returned");
  };
  const delivered = await patchStatus(database, 121, "delivered");

  assert.equal(returned?.status, 200);
  assert.equal(delivered.status, 409);
  assert.match(((await delivered.json()) as { error: string }).error, /Status order berubah/);
  assert.equal(database.state.orders.get(121)?.shipping_status, "returned");
  assert.ok(database.state.orders.get(121)?.stock_restored_at, "the return that succeeded voided the order");
});

test("a refused status write never sets the void marker", async () => {
  const database = databaseWithOrders(shippedOrder(122));
  database.beforeNextBatch = async () => {
    await patchStatus(database, 122, "delivered");
  };
  const returned = await patchStatus(database, 122, "returned");

  assert.equal(returned.status, 409);
  assert.equal(database.state.orders.get(122)?.shipping_status, "delivered");
  assert.equal(database.state.orders.get(122)?.stock_restored_at, null);
});

test("a payment marked paid by hand is refused when the payment method changed after validation", async () => {
  // Validated as COD, where an operator may mark `paid`; by the write the
  // order is QRIS, where only the AutoLaris reconciliation may. The two
  // statuses never moved, so only the method in the guard can refuse it.
  const database = databaseWithOrders(order(124));
  database.beforeNextBatch = () => {
    database.state.orders.get(124)!.payment_method = "qris";
  };
  const response = await detailRoute.PATCH({
    params: { id: "124" },
    request: new Request("https://example.test/api/admin/orders/124", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payment_status: "paid" }),
    }),
    locals: locals(database),
  } as never);

  assert.equal(response.status, 409);
  assert.equal(database.state.orders.get(124)?.payment_status, "unpaid");
});

test("a single uncontended status change still applies", async () => {
  const database = databaseWithOrders(shippedOrder(123));
  const response = await patchStatus(database, 123, "delivered");
  assert.equal(response.status, 200);
  assert.equal(database.state.orders.get(123)?.shipping_status, "delivered");
});

test("the guarded write and the bulk write hold on a real SQLite engine", async () => {
  const database = new SqliteD1Database();
  database.exec(`
    INSERT INTO orders (id, order_number, payment_method, payment_status, shipping_status, courier_code, cnote_no, provider_order_id) VALUES
      (131, 'INV-10131', 'cod', 'unpaid', 'processing', 'jne', 'W-131', 'MGN-131'),
      (132, 'INV-10132', 'cod', 'unpaid', 'processing', 'jne', 'W-132', 'MGN-132'),
      (133, 'INV-10133', 'cod', 'unpaid', 'processing', 'jne', 'W-133', 'MGN-133'),
      (134, 'INV-10134', 'cod', 'unpaid', 'pending', NULL, NULL, NULL),
      (135, 'INV-10135', 'cod', 'unpaid', 'pending', NULL, NULL, NULL);
  `);
  const d1 = database as unknown as D1Database;
  const row = (id: number) =>
    ({ ...database.get<Record<string, unknown>>(`SELECT shipping_status, stock_restored_at FROM orders WHERE id = ${id}`) });

  // Single: both changes carry the state they were validated against.
  const validated = (await d1.prepare("SELECT * FROM orders WHERE id = ?").bind(131).first<OrderLifecycleState>())!;
  const write = (status: string) =>
    applyOrderLifecycleMutation(
      d1,
      validated,
      { shippingStatus: status },
      d1
        .prepare("UPDATE orders SET shipping_status = ? WHERE id = ? AND payment_method = ? AND payment_status = ? AND shipping_status = ?")
        .bind(status, 131, validated.payment_method, validated.payment_status, validated.shipping_status),
    );
  assert.equal((await write("returned")).updated, true);
  assert.deepEqual(await write("delivered"), { updated: false, stockRestored: false });
  assert.equal(row(131).shipping_status, "returned");
  assert.ok(row(131).stock_restored_at);

  // Bulk: 133 is returned by someone else after validation; 132 still applies.
  const interleaved = (lateWrite: string) =>
    ({
      prepare: (sql: string) => database.prepare(sql),
      batch(statements: D1PreparedStatement[]) {
        database.exec(lateWrite);
        return database.batch(statements);
      },
    }) as unknown as D1Database;
  assert.deepEqual(
    await updateAdminOrderShippingStatuses(
      interleaved("UPDATE orders SET shipping_status = 'returned' WHERE id = 133"),
      [132, 133],
      "delivered",
    ),
    { updatedIds: [132], conflictIds: [133] },
  );
  assert.equal(row(132).shipping_status, "delivered");
  assert.equal(row(133).shipping_status, "returned");

  // Bulk cancel: 135 is pushed to the courier after validation. It is skipped
  // and, unlike 134, never marked void.
  assert.deepEqual(
    await updateAdminOrderShippingStatuses(
      interleaved("UPDATE orders SET shipping_status = 'processing', provider_order_id = 'MGN-135' WHERE id = 135"),
      [134, 135],
      "cancelled",
    ),
    { updatedIds: [134], conflictIds: [135] },
  );
  assert.equal(row(134).shipping_status, "cancelled");
  assert.ok(row(134).stock_restored_at);
  assert.deepEqual(row(135), { shipping_status: "processing", stock_restored_at: null });

  // The payment method is part of the validated state.
  assert.deepEqual(
    await updateAdminOrderShippingStatuses(
      interleaved("UPDATE orders SET payment_method = 'qris' WHERE id = 132"),
      [132],
      "returned",
    ),
    { updatedIds: [], conflictIds: [132] },
  );
  assert.equal(row(132).shipping_status, "delivered");
});

test("the bulk status route applies the rest and names the conflicts", async () => {
  type BulkBody = { success: boolean; error?: string; message?: string; data: { updated_count: number; conflict_order_ids: string[] } };
  const partial = databaseWithOrders(shippedOrder(141), shippedOrder(142));
  partial.beforeNextBatch = () => {
    partial.state.orders.get(142)!.shipping_status = "returned";
  };
  const response = await bulkStatus(partial, [141, 142], "delivered");
  const body = (await response.json()) as BulkBody;
  assert.equal(response.status, 200);
  assert.equal(body.data.updated_count, 1);
  assert.deepEqual(body.data.conflict_order_ids, ["142"]);
  assert.match(body.message || "", /1 order tidak diubah/);
  assert.equal(partial.state.orders.get(141)?.shipping_status, "delivered");
  assert.equal(partial.state.orders.get(142)?.shipping_status, "returned");

  // Nothing applied is a conflict, not a success with a zero.
  const none = databaseWithOrders(shippedOrder(143));
  none.beforeNextBatch = () => {
    none.state.orders.get(143)!.shipping_status = "returned";
  };
  const refused = await bulkStatus(none, [143], "delivered");
  const refusedBody = (await refused.json()) as BulkBody;
  assert.equal(refused.status, 409);
  assert.equal(refusedBody.success, false);
  assert.deepEqual(refusedBody.data.conflict_order_ids, ["143"]);
  assert.equal(none.state.orders.get(143)?.shipping_status, "returned");
});

test("DIGITAL-PRODUCTS-SPEC §2.3/§8.1: a delivered digital order can be refunded or cancelled without a waybill; a physical one still needs it", () => {
  const digital = { ...order(9, "delivered"), payment_method: "qris", payment_status: "paid", fulfillment_type: "digital" };
  // A refund voids the order: it is no longer "delivered", so it is cancelled with the refund.
  assert.deepEqual(resolveAdminOrderTransition(digital, { paymentStatus: "refunded", shippingStatus: "cancelled" }), { paymentStatus: "refunded", shippingStatus: "cancelled", releasesStock: true });
  assert.equal(resolveAdminOrderTransition(digital, { shippingStatus: "cancelled" }).releasesStock, true);
  assert.throws(() => resolveAdminOrderTransition(digital, { paymentStatus: "refunded" }), /paid/, "a refunded order is never left delivered");
  const physical = { ...order(10, "delivered"), payment_method: "qris", payment_status: "paid" };
  assert.throws(() => resolveAdminOrderTransition(physical, { paymentStatus: "refunded" }), /nomor resi/, "a delivered physical order without its waybill stays refused");
});

