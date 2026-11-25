import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { withTestCredentials } from "../platform/testing/credentials.ts";
import { issueWebhookToken } from "../platform/webhook-secrets.ts";
import { sealCredential } from "./credential-crypto.ts";
import {
  computeMengantarWebhookSignature,
  mapMengantarWebhookStatusCategory,
  purgeExpiredMengantarWebhookEvents,
  readMengantarWebhookHealth,
  verifyMengantarWebhookSignature,
} from "./mengantar-webhook.ts";
import { POST as mengantarWebhookPost } from "../pages/api/webhooks/mengantar/[token].ts";
import { PUT as adminSettingsPut, GET as adminSettingsGet } from "../pages/api/admin/settings.ts";

const MIGRATIONS_DIR = new URL("../db/migrations/", import.meta.url);
const PLATFORM_MIGRATIONS_DIR = new URL("../platform/migrations/", import.meta.url);

function migratedSqlite(dir: URL) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    for (const chunk of sql.split("--> statement-breakpoint")) {
      const trimmed = chunk.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
  return sqlite;
}

class Statement {
  private readonly sqlite: DatabaseSync;
  private readonly sql: string;
  private readonly values: unknown[];

  constructor(sqlite: DatabaseSync, sql: string, values: unknown[] = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]) {
    return new Statement(this.sqlite, this.sql, values);
  }

  async first<T>() {
    const row = this.sqlite.prepare(this.sql).get(...(this.values as never[]));
    return (row ? { ...(row as Record<string, unknown>) } : null) as T | null;
  }

  async all<T>() {
    const rows = this.sqlite.prepare(this.sql).all(...(this.values as never[]));
    return {
      success: true,
      results: rows.map((row) => ({ ...(row as Record<string, unknown>) })) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    const info = this.sqlite.prepare(this.sql).run(...(this.values as never[]));
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }

  execute() {
    const trimmed = this.sql.trim().toUpperCase();
    if (trimmed.startsWith("SELECT")) {
      const rows = this.sqlite.prepare(this.sql).all(...(this.values as never[]));
      return {
        success: true,
        results: rows.map((row) => ({ ...(row as Record<string, unknown>) })),
        meta: { changes: 0 },
      };
    }
    const info = this.sqlite.prepare(this.sql).run(...(this.values as never[]));
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

function asD1(sqlite: DatabaseSync) {
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  withTestCredentials(db);
  return db as unknown as D1Database;
}

async function setupWebhookHarness(secretPlain: string | null = "whsec-tenant-a-123456") {
  const platformSqlite = migratedSqlite(PLATFORM_MIGRATIONS_DIR);
  const tenantSqlite = migratedSqlite(MIGRATIONS_DIR);
  const platformDb = asD1(platformSqlite);
  const tenantDb = asD1(tenantSqlite);

  platformSqlite.exec(`
    INSERT INTO tenants (id, slug, status, plan_id, owner_email, created_at)
    VALUES
      ('t_a', 'toko-a', 'active', 'pilot', 'a@test.id', '2026-11-01T00:00:00.000Z'),
      ('t_b', 'toko-b', 'active', 'pilot', 'b@test.id', '2026-11-01T00:00:00.000Z');
    INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at)
    VALUES
      ('toko-a.adsbook.my.id', 't_a', 'subdomain', 'active', 1, '2026-11-01T00:00:00.000Z'),
      ('toko-b.adsbook.my.id', 't_b', 'subdomain', 'active', 1, '2026-11-01T00:00:00.000Z');
  `);

  const sealedSecret = secretPlain
    ? await sealCredential(tenantDb, "mengantar_webhook_secret", secretPlain)
    : null;
  tenantSqlite
    .prepare(
      `INSERT INTO stores (id, name, slug, created_at, mengantar_api_key, mengantar_base_url, mengantar_webhook_secret)
       VALUES (1, 'Toko A', 'toko-a', '2026-11-01T00:00:00.000Z', 'key-a', 'https://provider.invalid', ?)`,
    )
    .run(sealedSecret);

  const tokenA = await issueWebhookToken(platformDb, "t_a", "mengantar");
  const tokenB = await issueWebhookToken(platformDb, "t_b", "mengantar");

  return { platformSqlite, tenantSqlite, platformDb, tenantDb, tokenA, tokenB, secretPlain };
}

test("T-1: Mengantar official HMAC-SHA256 test vector passes and single-byte tamper fails", async () => {
  const rawBody = '{"cnote_no":"JNE1234567890","order_id":"ORD-000123","courier":"JNE","status_category":"DELIVERED"}';
  const expected = "05826dec707ea7164801d952cb7eaf7ce9adc0c8aa0b93366480434164a1a111";
  const computed = await computeMengantarWebhookSignature("1787548800000", rawBody, "testsecret");
  assert.equal(computed, expected);

  const valid = await verifyMengantarWebhookSignature({
    timestamp: "1787548800000",
    signature: expected,
    rawBody,
    secret: "testsecret",
    nowMs: 1787548800000 + 1000,
  });
  assert.equal(valid.ok, true);

  const tamperedBody = rawBody.replace("DELIVERED", "DELIVERE!");
  const tampered = await verifyMengantarWebhookSignature({
    timestamp: "1787548800000",
    signature: expected,
    rawBody: tamperedBody,
    secret: "testsecret",
    nowMs: 1787548800000 + 1000,
  });
  assert.deepEqual(tampered, { ok: false, reason: "invalid_signature" });
});

test("T-2 / T-3 / W-6: rejects custom host, wrong/cross-tenant token, sandbox header, stale/future timestamp, and missing secret without writing", async () => {
  const { platformDb, tenantDb, tenantSqlite, tokenA, tokenB, secretPlain } = await setupWebhookHarness("whsec-t23");
  const nowMs = Date.now();
  const body = JSON.stringify({
    cnote_no: "JNE-1",
    order_id: "MG-1",
    courier: "JNE",
    service_code: "REG",
    status_category: "DELIVERED",
  });
  const sig = await computeMengantarWebhookSignature(String(nowMs), body, secretPlain!);

  const call = (opts: {
    hostKind?: "subdomain" | "custom";
    token?: string;
    headers?: Record<string, string>;
    rawBody?: string;
    tenantDbOverride?: D1Database;
  }) =>
    mengantarWebhookPost({
      params: { token: opts.token ?? tokenA },
      request: new Request(`https://toko-a.adsbook.my.id/api/webhooks/mengantar/${opts.token ?? tokenA}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(nowMs),
          "x-signature": sig,
          ...(opts.headers ?? {}),
        },
        body: opts.rawBody ?? body,
      }),
      locals: {
        runtimeEnv: { PLATFORM_DB: platformDb },
        tenantContext: { tenantId: "t_a", hostKind: opts.hostKind ?? "subdomain" },
        tenantDb: opts.tenantDbOverride ?? tenantDb,
        requestId: "req-test",
      },
    } as unknown as Parameters<typeof mengantarWebhookPost>[0]);

  assert.equal((await call({ hostKind: "custom" })).status, 404, "custom domain refused");
  assert.equal((await call({ token: "0".repeat(64) })).status, 401, "wrong token refused");
  assert.equal((await call({ token: tokenB })).status, 401, "other tenant token refused");
  assert.equal((await call({ headers: { "x-environment": "sandbox" } })).status, 403, "sandbox header refused in prod");

  const staleTs = String(nowMs - 6 * 60 * 1000);
  const staleSig = await computeMengantarWebhookSignature(staleTs, body, secretPlain!);
  assert.equal((await call({ headers: { "x-timestamp": staleTs, "x-signature": staleSig } })).status, 401, "stale timestamp refused");

  const futureTs = String(nowMs + 6 * 60 * 1000);
  const futureSig = await computeMengantarWebhookSignature(futureTs, body, secretPlain!);
  assert.equal((await call({ headers: { "x-timestamp": futureTs, "x-signature": futureSig } })).status, 401, "future timestamp refused");

  // W-6: store with no webhook secret returns 401 and writes nothing
  const noSecret = await setupWebhookHarness(null);
  const noSecretResp = await mengantarWebhookPost({
    params: { token: noSecret.tokenA },
    request: new Request(`https://toko-a.adsbook.my.id/api/webhooks/mengantar/${noSecret.tokenA}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": String(nowMs), "x-signature": sig },
      body,
    }),
    locals: {
      runtimeEnv: { PLATFORM_DB: noSecret.platformDb },
      tenantContext: { tenantId: "t_a", hostKind: "subdomain" },
      tenantDb: noSecret.tenantDb,
    },
  } as unknown as Parameters<typeof mengantarWebhookPost>[0]);
  assert.equal(noSecretResp.status, 401);

  const countA = (tenantSqlite.prepare("SELECT COUNT(*) AS c FROM mengantar_webhook_events").get() as { c: number }).c;
  const countNoSecret = (noSecret.tenantSqlite.prepare("SELECT COUNT(*) AS c FROM mengantar_webhook_events").get() as { c: number }).c;
  assert.equal(countA, 0, "rejected requests never write event rows");
  assert.equal(countNoSecret, 0, "missing-secret store writes nothing");
});

test("T-4 / T-5 / T-6 / T-8 / X-7: dedupe, event ordering, RTS once-only void, CANCELED/unknown non-mutation, external skip, and waitUntil fast ack", async () => {
  const { platformDb, tenantDb, tenantSqlite, tokenA, secretPlain } = await setupWebhookHarness("whsec-flow-999");
  tenantSqlite.exec(`
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, courier_code, cnote_no, provider_order_id, shipping_channel, created_at)
    VALUES
      (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 100000, 'cod', 'unpaid', 'processing', 'JNE', 'JNE-001', 'MG-1', 'mengantar', '2026-11-20T03:00:00.000Z'),
      (2, 'INV-10002', 1, 'Siti', '6281234567891', 'Jl. Merdeka No. 11', 'Jawa Barat', 'Bandung', 'Coblong', 120000, 'cod', 'unpaid', 'shipped', 'JNE', 'JNE-002', 'MG-2', 'mengantar', '2026-11-20T03:00:00.000Z'),
      (3, 'INV-10003', 1, 'Ani', '6281234567892', 'Jl. Merdeka No. 12', 'Jawa Barat', 'Bandung', 'Coblong', 90000, 'cod', 'unpaid', 'processing', 'SiCepat', 'EXT-003', NULL, 'external', '2026-11-20T03:00:00.000Z');
  `);

  const baseNow = Date.now();
  const waitPromises: Promise<unknown>[] = [];
  const send = async (payload: Record<string, unknown>, tsOffsetMs: number, useWaitUntil = false) => {
    const ts = String(baseNow + tsOffsetMs);
    const raw = JSON.stringify(payload);
    const sig = await computeMengantarWebhookSignature(ts, raw, secretPlain!);
    const resp = await mengantarWebhookPost({
      params: { token: tokenA },
      request: new Request(`https://toko-a.adsbook.my.id/api/webhooks/mengantar/${tokenA}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
        body: raw,
      }),
      locals: {
        runtimeEnv: { PLATFORM_DB: platformDb },
        tenantContext: { tenantId: "t_a", hostKind: "subdomain" },
        tenantDb,
        requestId: `req-${tsOffsetMs}`,
        ...(useWaitUntil
          ? {
              cfContext: {
                waitUntil(promise: Promise<unknown>) {
                  waitPromises.push(promise);
                },
              },
            }
          : {}),
      },
    } as unknown as Parameters<typeof mengantarWebhookPost>[0]);
    return { status: resp.status, body: (await resp.json()) as { received?: boolean; duplicate?: boolean } };
  };

  // T-8: DELIVERED scheduled via waitUntil acknowledges 200 immediately
  const delivered = await send({ cnote_no: "JNE-001", order_id: "MG-1", courier: "JNE", service_code: "REG", status_category: "DELIVERED" }, 0, true);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.duplicate, false);
  assert.equal(waitPromises.length, 1, "heavy processing scheduled via waitUntil");
  await Promise.all(waitPromises);
  assert.equal((tenantSqlite.prepare("SELECT shipping_status FROM orders WHERE id = 1").get() as { shipping_status: string }).shipping_status, "delivered");

  // T-4: exact duplicate returns duplicate:true and writes no second row
  const duplicate = await send({ cnote_no: "JNE-001", order_id: "MG-1", courier: "JNE", service_code: "REG", status_category: "DELIVERED" }, 0);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const dupCount = (tenantSqlite.prepare("SELECT COUNT(*) AS c FROM mengantar_webhook_events WHERE cnote_no = 'JNE-001'").get() as { c: number }).c;
  assert.equal(dupCount, 1);

  // T-4: older out-of-order ON DELIVERY and newer ON DELIVERY cannot regress DELIVERED
  await send({ cnote_no: "JNE-001", order_id: "MG-1", courier: "JNE", status_category: "ON DELIVERY" }, -5000);
  await send({ cnote_no: "JNE-001", order_id: "MG-1", courier: "JNE", status_category: "ON DELIVERY" }, 5000);
  assert.equal((tenantSqlite.prepare("SELECT shipping_status FROM orders WHERE id = 1").get() as { shipping_status: string }).shipping_status, "delivered");

  // T-6: CANCELED, CANCELLED, and unknown category do NOT mutate shipping_status
  assert.equal(mapMengantarWebhookStatusCategory("CANCELED").shippingStatus, null);
  assert.equal(mapMengantarWebhookStatusCategory("CANCELLED").shippingStatus, null);
  assert.equal(mapMengantarWebhookStatusCategory("FUTURE_STATE_XYZ").mapped, false);
  await send({ cnote_no: "JNE-002", order_id: "MG-2", courier: "JNE", status_category: "CANCELED" }, 1000);
  await send({ cnote_no: "JNE-002", order_id: "MG-2", courier: "JNE", status_category: "CANCELLED" }, 2000);
  await send({ cnote_no: "JNE-002", order_id: "MG-2", courier: "JNE", status_category: "FUTURE_STATE_XYZ" }, 3000);
  assert.equal((tenantSqlite.prepare("SELECT shipping_status FROM orders WHERE id = 2").get() as { shipping_status: string }).shipping_status, "shipped");

  // T-5: RTS twice voids once (stock_restored_at preserved across second RTS)
  await send({ cnote_no: "JNE-002", order_id: "MG-2", courier: "JNE", status_category: "RTS" }, 4000);
  const afterFirstRts = tenantSqlite.prepare("SELECT shipping_status, stock_restored_at FROM orders WHERE id = 2").get() as { shipping_status: string; stock_restored_at: string | null };
  assert.equal(afterFirstRts.shipping_status, "returned");
  assert.ok(afterFirstRts.stock_restored_at, "RTS sets void marker once");
  await send({ cnote_no: "JNE-002", order_id: "MG-2", courier: "JNE", status_category: "RTS" }, 8000);
  const afterSecondRts = tenantSqlite.prepare("SELECT shipping_status, stock_restored_at FROM orders WHERE id = 2").get() as { shipping_status: string; stock_restored_at: string | null };
  assert.equal(afterSecondRts.stock_restored_at, afterFirstRts.stock_restored_at, "second RTS does not re-void");

  // X-7 / X-8: webhook for external order is ignored as unknown_order and never updates it
  await send({ cnote_no: "EXT-003", order_id: "EXT-ID", courier: "SiCepat", status_category: "DELIVERED" }, 6000);
  const extOrder = tenantSqlite.prepare("SELECT shipping_status, provider_status_category FROM orders WHERE id = 3").get() as { shipping_status: string; provider_status_category: string | null };
  assert.equal(extOrder.shipping_status, "processing");
  assert.equal(extOrder.provider_status_category, null);
  const extEvent = tenantSqlite.prepare("SELECT outcome, order_id FROM mengantar_webhook_events WHERE cnote_no = 'EXT-003'").get() as { outcome: string; order_id: number | null };
  assert.equal(extEvent.outcome, "unknown_order");
  assert.equal(extEvent.order_id, null);
});

test("D-5 / A-2 / Settings API: 30-day event purge, 48h stale warning, optional Base URL save, and Mengantar webhook token issuance", async () => {
  const { platformDb, tenantDb, tenantSqlite } = await setupWebhookHarness(null);
  const now = new Date("2026-11-25T12:00:00.000Z");

  // Seed old (>30d) and recent webhook events
  tenantSqlite.exec(`
    INSERT INTO mengantar_webhook_events (received_at, event_at, cnote_no, status_category, body_sha256, outcome)
    VALUES
      ('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'OLD-1', 'DELIVERED', 'hash1', 'applied'),
      ('2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'NEW-1', 'ON DELIVERY', 'hash2', 'applied');
    INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, address, province, city, district, total_amount, payment_method, payment_status, shipping_status, courier_code, cnote_no, provider_order_id, shipping_channel, created_at)
    VALUES
      (1, 'INV-10001', 1, 'Budi', '6281234567890', 'Jl. Merdeka No. 10', 'Jawa Barat', 'Bandung', 'Coblong', 100000, 'cod', 'unpaid', 'shipped', 'JNE', 'JNE-001', 'MG-1', 'mengantar', '2026-11-22T00:00:00.000Z');
  `);

  const purged = await purgeExpiredMengantarWebhookEvents(tenantDb, now);
  assert.equal(purged, 1);

  // Last event was Nov 20 (>48h before Nov 25) and active order is >48h old -> stale warning true
  const health = await readMengantarWebhookHealth(tenantDb, true, now);
  assert.equal(health.lastEventAt, "2026-11-20T00:00:00.000Z");
  assert.equal(health.stale48hWarning, true);

  // Settings API: save Mengantar webhook secret WITHOUT submitting Base URLs (UI cleanup)
  const locals = {
    admin: { username: "owner", role: "owner", mustChangePassword: false },
    tenantDb,
    runtimeEnv: { PLATFORM_DB: platformDb },
    tenantContext: { tenantId: "t_a", hostKind: "subdomain" },
  };
  const issueResp = await adminSettingsPut({
    request: new Request("https://toko-a.adsbook.my.id/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "issue-webhook-token", provider: "mengantar" }),
    }),
    locals,
  } as unknown as Parameters<typeof adminSettingsPut>[0]);
  assert.equal(issueResp.status, 200);
  const issueBody = (await issueResp.json()) as { data: { provider: string; webhook_url: string } };
  assert.equal(issueBody.data.provider, "mengantar");
  assert.match(issueBody.data.webhook_url, /^https:\/\/toko-a\.adsbook\.my\.id\/api\/webhooks\/mengantar\/[0-9a-f]{64}$/);

  const rawSecret = "whsec-no-baseurl-needed-42";
  const saveResp = await adminSettingsPut({
    request: new Request("https://toko-a.adsbook.my.id/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save-integrations",
        integrations: { mengantar_webhook_secret: rawSecret },
      }),
    }),
    locals,
  } as unknown as Parameters<typeof adminSettingsPut>[0]);
  assert.equal(saveResp.status, 200);
  const saveText = await saveResp.text();
  assert.equal(saveText.includes(rawSecret), false, "save response never echoes raw webhook secret");

  const getResp = await adminSettingsGet({ locals } as unknown as Parameters<typeof adminSettingsGet>[0]);
  assert.equal(getResp.status, 200);
  const getText = await getResp.text();
  assert.equal(getText.includes(rawSecret), false, "GET settings never echoes raw webhook secret");
  const getJson = JSON.parse(getText) as {
    data: { credentials: { mengantar: { webhook_secret_configured: boolean; webhook_issued_at: string | null } } };
  };
  assert.equal(getJson.data.credentials.mengantar.webhook_secret_configured, true);
  assert.ok(getJson.data.credentials.mengantar.webhook_issued_at);
});
