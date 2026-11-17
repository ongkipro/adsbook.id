import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ProviderAddressRow } from "../lib/location-search.ts";
import { dropRefusedDestination, readMengantarArea, resetAreaProbeCooldown, resolveMengantarArea } from "../lib/mengantar-areas.ts";
import { splitMigrationStatements } from "../lib/schema-version.ts";
import { cachedEstimator, rateCacheKey } from "../lib/rate-cache.ts";
import { sharedAreaDropper, sharedAreaLayer } from "./shared-areas.ts";

/** A D1-shaped handle over node:sqlite with the given migration chain applied. */
function d1(dir: URL) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = OFF");
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of splitMigrationStatements(readFileSync(new URL(name, dir), "utf8"))) sqlite.exec(statement);
  }
  const database = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => { bound.push(...values); return statement; },
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(bound as never[])).changes) } }),
        first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...(bound as never[])) }),
      };
      return statement;
    },
  } as unknown as D1Database;
  return { sqlite, database };
}
const tenantStore = () => d1(new URL("../db/migrations/", import.meta.url));
const controlPlane = () => d1(new URL("./migrations/", import.meta.url));

const COBLONG: ProviderAddressRow[] = [
  { _id: "A-CBL-1", DISTRICT_NAME: "Coblong", SUBDISTRICT_NAME: "Dago", CITY_NAME: "Bandung", PROVINCE_NAME: "Jawa Barat", ZIP_CODE: "40135" },
];
function mengantar() {
  const calls: string[] = [];
  const search = async (keyword: string) => {
    calls.push(keyword);
    return keyword.startsWith("Coblong") ? COBLONG : [];
  };
  return { calls, provider: async () => search };
}
const coblong = { district: "Coblong", city: "Bandung", province: "Jawa Barat" };

test("a district one store resolved answers every other store with no Mengantar call, and no tenant data is shared", async () => {
  const platform = controlPlane();
  const env = { PLATFORM_DB: platform.database };
  const storeA = tenantStore();
  const storeB = tenantStore();

  const a = mengantar();
  const first = await resolveMengantarArea(storeA.database, a.provider, coblong, sharedAreaLayer(env));
  assert.equal(first?.stored, false);
  assert.equal(a.calls.length, 1, "store A asked Mengantar");

  const b = mengantar();
  const second = await resolveMengantarArea(storeB.database, b.provider, coblong, sharedAreaLayer(env));
  assert.equal(b.calls.length, 0, "store B never asked Mengantar");
  assert.equal(second?.body, first?.body, "same bytes the provider resolve gave");
  assert.equal(await readMengantarArea(storeB.database, coblong), first?.body, "store B keeps its own copy");

  // What the shared row holds: public geography only.
  const columns = (platform.sqlite.prepare("PRAGMA table_info(shared_mengantar_areas)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(columns.sort(), ["area_id", "area_key", "label", "payload", "postal_code", "resolved_at"]);
  const row = platform.sqlite.prepare("SELECT * FROM shared_mengantar_areas").get() as Record<string, string>;
  assert.equal(row.area_id, "A-CBL-1");
  assert.equal(row.postal_code, "40135");
  assert.doesNotMatch(JSON.stringify(row), /tenant|t_[a-z0-9]{6}|api[_-]?key|customer|phone/i);
});

test("without a control plane the resolve is the tenant store plus Mengantar, as before", async () => {
  assert.equal(sharedAreaLayer({}), undefined);
  assert.equal(sharedAreaDropper(undefined), undefined);
  const store = tenantStore();
  const m = mengantar();
  assert.equal((await resolveMengantarArea(store.database, m.provider, coblong, sharedAreaLayer({})))?.stored, false);
  assert.equal(m.calls.length, 1);
});

test("A-415: a destination Mengantar refuses is dropped from the shared layer too", async () => {
  resetAreaProbeCooldown();
  const platform = controlPlane();
  const env = { PLATFORM_DB: platform.database };
  const store = tenantStore();
  await resolveMengantarArea(store.database, mengantar().provider, coblong, sharedAreaLayer(env));
  const refusing = {
    estimateRates: async (input: { originId: string; destinationId: string }) => {
      if (input.destinationId === "A-CBL-1" || input.originId === "A-CBL-1") throw new Error("Area tidak ditemukan");
      return [];
    },
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const outcome = await dropRefusedDestination(
      store.database, refusing, { originId: "ORIG", destinationId: "A-CBL-1" }, new Error("refused"), new Date(Date.now() + 1000), sharedAreaDropper(env),
    );
    assert.equal(outcome, "dropped");
  } finally {
    console.warn = warn;
  }
  assert.equal(platform.sqlite.prepare("SELECT COUNT(*) AS n FROM shared_mengantar_areas").get()?.n, 0);
  const next = mengantar();
  await resolveMengantarArea(tenantStore().database, next.provider, coblong, sharedAreaLayer(env));
  assert.equal(next.calls.length, 1, "the next store resolves it afresh");
});

/** An in-memory stand-in for caches.default. */
function memoryCache() {
  const entries = new Map<string, string>();
  return {
    entries,
    match: async (request: Request) => (entries.has(request.url) ? new Response(entries.get(request.url)) : undefined),
    put: async (request: Request, response: Response) => { entries.set(request.url, await response.text()); },
  };
}

test("estimates are cached per tenant: a repeat quote skips Mengantar, another store never reads it", async () => {
  const cache = memoryCache();
  let calls = 0;
  const estimate = async () => {
    calls += 1;
    return [{ courier_code: "JNE", courier_service: "REG", price: 12000, estimated_days: "2-3", unsupported: false, unsupported_cod: false, cod_fee: 0 }];
  };
  const route = { originId: "ORIG", destinationId: "A-CBL-1", weight: 1 };
  const tenantA = { tenantId: "t_aaaaaa", cacheVersion: 1 };
  const tenantB = { tenantId: "t_bbbbbb", cacheVersion: 1 };

  const a = cachedEstimator(estimate as never, tenantA, cache);
  assert.equal((await a(route))[0].price, 12000);
  assert.equal((await a(route))[0].price, 12000);
  assert.equal(calls, 1, "the second quote of the same route is a cache hit");

  await cachedEstimator(estimate as never, tenantB, cache)(route);
  assert.equal(calls, 2, "store B's own key and rates: never store A's estimate");
  assert.notEqual(rateCacheKey(tenantA, route).url, rateCacheKey(tenantB, route).url);

  await a({ ...route, weight: 2 });
  assert.equal(calls, 3, "another weight is another quote");
  await cachedEstimator(estimate as never, { ...tenantA, cacheVersion: 2 }, cache)(route);
  assert.equal(calls, 4, "a bumped cache version starts empty");

  // A refusal is never cached.
  let refusals = 0;
  const refusing = cachedEstimator(async () => { refusals += 1; throw new Error("refused"); }, tenantA, cache);
  const other = { ...route, destinationId: "A-X" };
  await assert.rejects(refusing(other));
  await assert.rejects(refusing(other));
  assert.equal(refusals, 2);

  // No tenant scope: no cache at all.
  const unscoped = cachedEstimator(estimate as never, undefined, cache);
  await unscoped(route);
  assert.equal(calls, 5);
});
