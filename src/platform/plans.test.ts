// T-37: caps come from the tenant's plan row, per tenant, and move with it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import { claimDomain, cloudflareHostnameApi } from "./hostnames.ts";
import { checkPlanCap, recordUsage, tenantPlan } from "./plans.ts";
import { createFakeCloudflare } from "./testing/fake-cloudflare.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

async function setup() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  for (const id of ["t-a", "t-b"]) {
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, 'active', '2026-11-16')").run(id, id, `${id}@example.test`);
  }
  const setPlan = (column: string, value: number) => db.sqlite.prepare(`UPDATE plans SET ${column} = ? WHERE id = 'pilot'`).run(value);
  return { db, setPlan };
}

test("the pilot plan's limits come from its row", async () => {
  const { db } = await setup();
  assert.deepEqual(await tenantPlan(db, "t-a"), { planId: "pilot", maxCustomDomains: 2, mediaUploadsPerHour: 60, aiGenerationsPerHour: 20 });
  assert.equal(await tenantPlan(db, "t-none"), null);
});

for (const cap of ["media", "ai"] as const) {
  test(`the ${cap} cap refuses at the plan limit, per tenant, and moves when the plan changes`, async () => {
    const { db, setPlan } = await setup();
    const column = cap === "media" ? "media_uploads_per_hour" : "ai_generations_per_hour";
    setPlan(column, 2);
    assert.equal((await checkPlanCap(db, "t-a", cap, false)).allowed, true, "a peek spends nothing");
    assert.equal((await checkPlanCap(db, "t-a", cap, true)).allowed, true);
    assert.equal((await checkPlanCap(db, "t-a", cap, true)).allowed, true);
    const refused = await checkPlanCap(db, "t-a", cap, true);
    assert.equal(refused.allowed, false);
    assert.equal((await checkPlanCap(db, "t-b", cap, true)).allowed, true, "another tenant's allowance is its own");
    setPlan(column, 5);
    assert.equal((await checkPlanCap(db, "t-a", cap, true)).allowed, true, "a raised plan limit applies at once");
    setPlan(column, 0);
    const off = await checkPlanCap(db, "t-a", cap, false);
    assert.equal(off.allowed, false);
    assert.equal((await checkPlanCap(db, "t-none", cap, false)).allowed, false, "no plan, no allowance");
  });
}

test("the hostname cap follows the plan; a third domain creates no Cloudflare hostname; root + www counts once", async () => {
  const { db, setPlan } = await setup();
  db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES ('t-a.adsbook.cc', 't-a', 'subdomain', 'active', 1, '2026-11-16')").run();
  const cloudflare = createFakeCloudflare();
  const api = cloudflareHostnameApi({ zoneId: cloudflare.zoneId, token: cloudflare.token, base: "https://cf.test/client/v4", fetcher: cloudflare.fetch });
  assert.ok((await claimDomain(db, api, "t-a", "satu.com", "root")).ok, "apex + www: one domain");
  assert.ok((await claimDomain(db, api, "t-a", "dua.com", "subdomain")).ok);
  const posts = () => cloudflare.calls.filter((call) => call.method === "POST").length;
  const before = posts();
  assert.equal((await claimDomain(db, api, "t-a", "tiga.com", "subdomain")).ok, false);
  assert.equal(posts(), before, "the third domain reached Cloudflare");
  setPlan("max_custom_domains", 3);
  assert.ok((await claimDomain(db, api, "t-a", "tiga.com", "subdomain")).ok, "a raised plan admits it");
});

test("one usage row per tenant per day, accumulated", async () => {
  const { db } = await setup();
  const day = new Date("2026-11-16T03:00:00Z");
  await recordUsage(db, "t-a", { mediaBytes: 100 }, day);
  await recordUsage(db, "t-a", { mediaBytes: 50, orders: 1 }, day);
  await recordUsage(db, "t-a", {}, new Date("2026-11-17T01:00:00Z"));
  await recordUsage(db, "t-b", {}, day);
  const rows = db.sqlite.prepare("SELECT tenant_id, day, media_bytes, orders FROM tenant_usage_daily ORDER BY tenant_id, day").all().map((row) => ({ ...(row as object) }));
  assert.deepEqual(rows, [
    { tenant_id: "t-a", day: "2026-11-16", media_bytes: 150, orders: 1 },
    { tenant_id: "t-a", day: "2026-11-17", media_bytes: 0, orders: 0 },
    { tenant_id: "t-b", day: "2026-11-16", media_bytes: 0, orders: 0 },
  ]);
});

test("card twins have their own allowance of the media cap's size, and none on a plan without media (T-37 review)", async () => {
  const { db, setPlan } = await setup();
  setPlan("media_uploads_per_hour", 1);
  assert.equal((await checkPlanCap(db, "t-a", "media", true)).allowed, true);
  assert.equal((await checkPlanCap(db, "t-a", "media", true)).allowed, false);
  assert.equal((await checkPlanCap(db, "t-a", "media-derivative", true)).allowed, true, "the twin of the counted upload");
  assert.equal((await checkPlanCap(db, "t-a", "media-derivative", true)).allowed, false, "twins are bounded too");
  setPlan("media_uploads_per_hour", 0);
  assert.equal((await checkPlanCap(db, "t-b", "media-derivative", true)).allowed, false);
});

test("concurrent spends never pass the cap (T-37 review)", async () => {
  const { db, setPlan } = await setup();
  setPlan("media_uploads_per_hour", 3);
  const results = await Promise.all(Array.from({ length: 10 }, () => checkPlanCap(db, "t-a", "media", true)));
  assert.equal(results.filter((result) => result.allowed).length, 3);
});

test("a store error closes the cap instead of opening it (T-37)", async () => {
  const { db } = await setup();
  db.failWhen = /INSERT INTO rate_limits/;
  try {
    await assert.rejects(checkPlanCap(db, "t-a", "media", true));
  } finally {
    db.failWhen = null;
  }
});
