// SPIKE-1 driver: runs every local measurement against `wrangler dev --local`
// and writes results/local-<date>.json. Usage: node scripts/measure.mjs [base]
import { mkdirSync, writeFileSync } from "node:fs";

const base = (process.argv[2] || "http://127.0.0.1:8797").replace(/\/$/, "");
const get = async (path) => {
  const response = await fetch(base + path, { method: "POST" });
  const body = await response.json();
  return { status: response.status, body };
};
const out = { base, at: new Date().toISOString(), node: process.version };
const tenant = (name) => `spike-${name}-${Date.now()}`;

// 4. Full replay 0000→0079 in a store, schema compared with local D1 (sqlite_master).
const a = tenant("a");
const b = tenant("b");
out.replay = {
  tenantA: (await get(`/t/${a}/migrate?target=80`)).body,
  ref: (await get("/ref/migrate?target=80")).body,
};
const [schemaA, schemaRef] = [(await get(`/t/${a}/schema`)).body, (await get("/ref/schema")).body];
const key = (row) => `${row.type}:${row.name}`;
const refMap = new Map(schemaRef.map((row) => [key(row), row.sql]));
out.replay.objects = { store: schemaA.length, d1: schemaRef.length };
// `__miniflare_do_name` is the local runtime's own bookkeeping table inside every object.
const internal = (row) => row.name === "__miniflare_do_name";
out.replay.ignored = schemaA.filter(internal).map(key);
out.replay.diff = schemaA.filter((row) => !internal(row))
  .filter((row) => refMap.get(key(row)) !== row.sql)
  .map(key)
  .concat(schemaRef.filter((row) => !schemaA.some((r) => key(r) === key(row))).map(key));

// Two tenants created on first use, no redeploy; each is its own database.
out.tenantB = (await get(`/t/${b}/migrate?target=80`)).body;
await get(`/t/${a}/seed?orders=50`);
await get(`/t/${b}/seed?orders=3`);
out.isolation = {
  a: (await get(`/t/${a}/hit`)).body,
  bOrders: (await get(`/t/${b}/bench?n=1`)).status,
};

// 4b. Upgrade from 0060 with representative rows.
const u = tenant("upgrade");
out.upgradeFrom0060 = {
  to0060: (await get(`/t/${u}/migrate?target=61`)).body,
  seeded: (await get(`/t/${u}/seed?orders=20`)).body,
  toHead: (await get(`/t/${u}/migrate?target=80`)).body,
  counts: (await get(`/t/${u}/count`)).body,
};

// 2. meta parity: a fresh store and the (already migrated) local D1.
const p = tenant("parity");
await get(`/t/${p}/migrate?target=80`);
await get(`/t/${p}/seed`);
await get("/ref/seed");
out.parity = { store: (await get(`/t/${p}/parity`)).body, d1: (await get("/ref/parity")).body };
out.parity.mismatches = Object.keys(out.parity.store).filter(
  (k) => JSON.stringify(out.parity.store[k]) !== JSON.stringify(out.parity.d1[k]),
);

// 5. Real lib code through the adapter and through D1.
const l = tenant("lib");
await get(`/t/${l}/migrate?target=80`);
await get(`/t/${l}/seed`);
out.lib = { store: (await get(`/t/${l}/lib`)).body };
out.lib.d1 = (await get("/ref/lib")).body;
out.lib.mismatches = Object.keys(out.lib.store).filter((k) => JSON.stringify(out.lib.store[k]) !== JSON.stringify(out.lib.d1[k]));

// 3. Probe items of §4.1 item 12.
out.probe = (await get(`/t/${a}/probe`)).body;

// 6. Migration protocol: failed and delayed bookmark write, failure → recovery → restore.
const m = tenant("protocol");
out.protocol = {
  bookmarkFails: (await get(`/t/${m}/migrate?target=80&fault=bookmark-fails`)).body,
  stateAfterFailedBookmark: (await get(`/t/${m}/state`)).body,
  bookmarkDelayed: (await get(`/t/${m}/migrate?target=81&fault=bookmark-delayed`)).body,
};
const before = (await get(`/t/${m}/state`)).body;
out.protocol.failing = (await get(`/t/${m}/migrate?target=82`)).body;
out.protocol.stateAfterFailure = (await get(`/t/${m}/state`)).body;
out.protocol.retryRefused = (await get(`/t/${m}/migrate?target=82`)).body;
out.protocol.otherTenantStillServes = (await get(`/t/${a}/hit`)).status;
out.protocol.before = before;
const bookmark = out.protocol.bookmarkDelayed.bookmark;
out.protocol.restore = (await get(`/t/${m}/restore?bookmark=${encodeURIComponent(bookmark ?? "")}`)).body;
out.protocol.afterRestore = (await get(`/t/${m}/state`)).body;

// 1. Adapter latency (in-Worker timing) against local D1, and 7. host resolution.
out.latency = {
  store: (await get(`/t/${a}/bench?n=300`)).body,
  d1: (await get("/ref/bench?n=300")).body,
  resolve: (await get("/resolve?n=300")).body,
};

// 8. 50 req/s × 60 s against one object: scripts/load.mjs, recorded beside this file.

mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/local-${out.at.slice(0, 10)}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ replayDiff: out.replay.diff, parityMismatches: out.parity.mismatches, libMismatches: out.lib.mismatches, latency: out.latency }, null, 2));
console.log(`written ${file.pathname}`);
