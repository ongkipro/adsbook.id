import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTrustedHeadlessShipping } from './headless-checkout.ts';

test('resolveTrustedHeadlessShipping requires server-quoted destination and courier', async () => {
  await assert.rejects(
    () =>
      resolveTrustedHeadlessShipping(
        { shipping_cost: -50000 },
        {
          customer_name: 'Tester',
          customer_phone: '081234567890',
          customer_email: '',
          address: 'Jalan Mawar No. 1, Bandung',
          district: 'Coblong',
          province: 'Jawa Barat',
          postal_code: '40132',
          payment_method: 'cod',
          variant_id: '12',
          quantity: 1,
          submit_token: 'sb_test_token_123456',
        },
        async () => ({ rates: [] }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      Reflect.get(error, 'code') === 'SHIPPING_QUOTE_REQUIRED',
  );
});

test('resolveTrustedHeadlessShipping trusts provider quote instead of client shipping_cost', async () => {
  const shipping = await resolveTrustedHeadlessShipping(
    {
      destination_id: 'dst-1',
      courier_code: 'jne',
      courier_service_id: 1,
      shipping_cost: -50000,
      city: 'Bandung',
    },
    {
      customer_name: 'Tester',
      customer_phone: '081234567890',
      customer_email: '',
      address: 'Jalan Mawar No. 1, Bandung',
      district: 'Coblong',
      province: 'Jawa Barat',
      postal_code: '40132',
      payment_method: 'cod',
      variant_id: '12',
      quantity: 1,
      submit_token: 'sb_test_token_123456',
    },
    async () => ({
      rates: [
        {
          courier_code: 'jne',
          courier_service: 'REG',
          price: 18000,
          estimated_days: '2-3',
          unsupported: false,
          unsupported_cod: false,
          cod_fee: 2500,
        },
      ],
      warehouse: {
        id: 9,
      },
    }),
  );

  assert.deepEqual(shipping, {
    destinationId: 'dst-1',
    // The provider's cod_fee is not shipping: persistOrder adds the store's own
    // COD service fee once, the same as storefront checkout (shipping-quote.ts).
    shippingCost: 18000,
    courierCode: 'jne',
    courierService: 'REG',
    warehouseId: 9,
  });
});

test('resolveTrustedHeadlessShipping refuses a primary price when the city chose another warehouse and none was echoed (finding 23)', async () => {
  // Two warehouses: the rate route, given `city`, quotes from warehouse 2 at
  // 30000; without it, from the primary (1) at 18000.
  const quoteResolver = async (input: { destinationProvince?: string; warehouseId?: number }) => {
    const fromSecond = input.warehouseId === 2 || Boolean(input.destinationProvince);
    return {
      rates: [
        {
          courier_code: 'jne',
          courier_service: 'REG',
          price: fromSecond ? 30000 : 18000,
          estimated_days: '2-3',
          unsupported: false,
          unsupported_cod: false,
          cod_fee: 0,
        },
      ],
      warehouse: { id: fromSecond ? 2 : 1 },
    };
  };
  const data = {
    customer_name: 'Tester',
    customer_phone: '081234567890',
    customer_email: '',
    address: 'Jalan Mawar No. 1, Bandung',
    district: 'Coblong',
    province: 'Jawa Barat',
    postal_code: '40132',
    payment_method: 'cod',
    variant_id: '12',
    quantity: 1,
    submit_token: 'sb_test_token_123456',
  } as const;
  const body = { destination_id: 'dst-1', courier_code: 'jne', courier_service_id: 1, city: 'Bandung' };

  // Checkout without `warehouse_id` is never silently charged the primary's 18000.
  await assert.rejects(
    () => resolveTrustedHeadlessShipping(body, data, quoteResolver),
    (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === 'SHIPPING_QUOTE_CHANGED',
  );
  // Echoing the rate call's `warehouse_id` charges what that call showed.
  const echoed = await resolveTrustedHeadlessShipping({ ...body, warehouse_id: 2 }, data, quoteResolver);
  assert.equal(echoed.shippingCost, 30000);
  assert.equal(echoed.warehouseId, 2);
  // No city: the rate call could only have shown the primary, which is charged.
  const { city: _city, ...withoutCity } = body;
  const primary = await resolveTrustedHeadlessShipping(withoutCity, data, quoteResolver);
  assert.equal(primary.shippingCost, 18000);
  assert.equal(primary.warehouseId, 1);
});

// ── PR-5: the AutoLaris switch, driven through both checkout routes on the real migration chain ──

import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { hashApiKeySecret } from './developer-api-keys.ts';
import { splitMigrationStatements } from './schema-version.ts';

// The routes import their libs without an extension, as Vite resolves them.
const extensionResolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || /\.[a-z0-9]+$/i.test(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
const headlessCheckoutRoute = await import('../pages/api/v1/checkout.ts');
const storefrontCheckoutRoute = await import('../pages/api/submit-order.ts');
extensionResolver.deregister();

const API_KEY = 'adsbook_live_autolaris_switch_test_key';

async function switchStore() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.sql')).sort()) {
    for (const sql of splitMigrationStatements(readFileSync(new URL(name, directory), 'utf8'))) sqlite.exec(sql);
  }
  sqlite.exec(`
    INSERT INTO stores (id, name, slug, created_at, autolaris_api_key, autolaris_base_url, is_autolaris_enabled)
      VALUES (1, 'Toko Uji', 'toko-uji', '2026-11-01T00:00:00.000Z', 'qa-key', 'https://autolaris.example.test', 0);
    INSERT INTO warehouses (id, store_id, name, origin_area_id, pickup_address_id, address, city, province, contact_name, contact_phone)
      VALUES (1, 1, 'Gudang', 'area-1', 'pickup-1', 'Jl. Gudang 1', 'Surabaya', 'Jawa Timur', 'PIC', '081300000000');
    INSERT INTO products (id, store_id, title, slug, created_at) VALUES (11111, 1, 'Pupuk', 'pupuk', '2026-11-01T00:00:00.000Z');
    INSERT INTO product_variants (id, product_id, sku, title, price) VALUES (101, 11111, 'P-1', '1 kg', 50000);
  `);
  sqlite
    .prepare(`INSERT INTO developer_api_keys (name, key_hash, key_preview, created_by, created_at)
      VALUES ('Storefront', ?, 'adsbook_live_…', 'owner', '2026-11-01T00:00:00.000Z')`)
    .run(await hashApiKeySecret(API_KEY));
  type Value = null | number | string;
  const statement = (sql: string, values: Value[] = []) => ({
    bind: (...next: Value[]) => statement(sql, next.map((value) => value ?? null)),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => {
      if (/^\s*SELECT\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...values), meta: { changes: 0 } };
      return { results: [], meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
    },
  });
  const database = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<ReturnType<typeof statement>>) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  const locals = {
    // The order rail is fully configured: only the switch stands in the way.
    runtimeEnv: { OMS_DB: database, AUTOLARIS_ORDER_ORIGIN_ID: 'origin-1', AUTOLARIS_ORDER_DESTINATION_ID: 'dest-1' },
    tenant: { siteUrl: 'https://store.example.test' },
  } as unknown as App.Locals;
  const count = (table: string) =>
    Number((sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total);
  return { sqlite, locals, count };
}

const qrisOrder = (submitToken: string) => ({
  customer_name: 'Siti Rahayu',
  customer_phone: '081234567890',
  address: 'Jalan Melati Nomor 10, Bogor',
  district: 'Bogor Tengah',
  province: 'Jawa Barat',
  city: 'Bogor',
  postal_code: '16111',
  payment_method: 'qris',
  payment_channel: 'QRIS',
  variant_id: '101',
  quantity: 1,
  submit_token: submitToken,
});

const post = (route: { POST: unknown }, path: string, body: unknown, locals: App.Locals) =>
  (route.POST as (context: unknown) => Promise<Response>)({
    request: new Request(`https://store.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-key': API_KEY },
      body: JSON.stringify(body),
    }),
    locals,
  });

test('with AutoLaris switched off, /api/v1/checkout refuses QRIS exactly as /api/submit-order does', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const providerCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    providerCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error('no provider call is expected while the switch is off');
  }) as typeof fetch;
  const { sqlite, locals, count } = await switchStore();

  const storefront = await post(storefrontCheckoutRoute, '/api/submit-order', qrisOrder('sb_switch_off_storefront_1'), locals);
  const storefrontBody = (await storefront.json()) as { error: string; code: string };
  const headless = await post(headlessCheckoutRoute, '/api/v1/checkout', qrisOrder('sb_switch_off_headless_01'), locals);
  const headlessBody = (await headless.json()) as { error: { message: string; code: string } };

  assert.equal(storefrontBody.code, 'PAYMENT_METHOD_UNAVAILABLE');
  assert.deepEqual(
    { status: headless.status, code: headlessBody.error.code, message: headlessBody.error.message },
    { status: storefront.status, code: storefrontBody.code, message: storefrontBody.error },
  );
  assert.equal(count('orders'), 0, 'a refused checkout must not leave an order row');
  assert.equal(count('payment_transactions'), 0);
  assert.deepEqual(providerCalls, [], 'no provider call may be made while the switch is off');

  // The refusal is the switch and nothing else: turned on, the same request
  // gets past the payment gate and stops at the next one, the shipping quote.
  sqlite.exec('UPDATE stores SET is_autolaris_enabled = 1');
  const enabled = await post(headlessCheckoutRoute, '/api/v1/checkout', qrisOrder('sb_switch_on_headless_001'), locals);
  const enabledBody = (await enabled.json()) as { error: { code: string } };
  assert.notEqual(enabledBody.error.code, 'PAYMENT_METHOD_UNAVAILABLE');
  assert.equal(enabledBody.error.code, 'SHIPPING_QUOTE_REQUIRED');
  assert.equal(count('orders'), 0);
});
