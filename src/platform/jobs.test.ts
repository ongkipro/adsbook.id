// T-24: the platform job's retention limits, one day inside and one outside
// each (PRIV-4, DOM-5), and the start of due purges.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import { runPlatformJobs, thirteenMonthsBefore } from "./jobs.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

const DAY = 24 * 60 * 60 * 1000;

async function controlPlane() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  const tenant = (id: string, status: string, purgeAfter: string | null) =>
    db.sqlite
      .prepare("INSERT INTO tenants (id, slug, owner_email, status, purge_after, created_at) VALUES (?, ?, ?, ?, ?, '2025-01-01')")
      .run(id, id, `${id}@example.test`, status, purgeAfter);
  return { db, tenant };
}

const count = (db: ReturnType<typeof createSqliteD1>, sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n;

test("PRIV-4: events past a year, usage past 13 months and handoff tokens 7 days past expiry go; one day younger stays", async () => {
  // The tenant_events delete trigger measures against the real clock, so this test does too.
  const now = new Date();
  const { db, tenant } = await controlPlane();
  tenant("t-1", "active", null);
  const at = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  for (const [kind, days] of [["old", 366], ["young", 364]] as const) {
    db.sqlite.prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at) VALUES ('t-1', ?, 'test', ?)").run(kind, at(days));
  }
  const cutoff = thirteenMonthsBefore(now);
  const dayShift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
  db.sqlite.prepare("INSERT INTO tenant_usage_daily (tenant_id, day) VALUES ('t-1', ?), ('t-1', ?)").run(dayShift(cutoff, -1), dayShift(cutoff, 1));
  for (const [hash, days] of [["expired-8d", 8], ["expired-6d", 6]] as const) {
    db.sqlite
      .prepare("INSERT INTO handoff_tokens (token_hash, tenant_id, purpose, host, expires_at) VALUES (?, 't-1', 'signup', 'x.belanja.cc', ?)")
      .run(hash, at(days));
  }

  const result = await runPlatformJobs(db, now);
  assert.equal(result.tenantEvents, 1);
  assert.equal(result.usageRows, 1);
  assert.equal(result.handoffTokens, 1);
  assert.deepEqual(db.sqlite.prepare("SELECT kind FROM tenant_events ORDER BY id").all().map((row) => (row as { kind: string }).kind), ["young"]);
  assert.deepEqual(
    db.sqlite.prepare("SELECT day FROM tenant_usage_daily").all().map((row) => (row as { day: string }).day),
    [dayShift(cutoff, 1)],
  );
  assert.deepEqual(db.sqlite.prepare("SELECT token_hash FROM handoff_tokens").all().map((row) => (row as { token_hash: string }).token_hash), ["expired-6d"]);
});

test("13 months is calendar months", () => {
  assert.equal(thirteenMonthsBefore(new Date("2026-11-16T05:00:00Z")), "2025-10-16");
  assert.equal(thirteenMonthsBefore(new Date("2026-01-31T00:00:00Z")), "2024-12-31");
});

test("DOM-5: a custom hostname pending 7 days is deleted at Cloudflare, then revoked; a younger one and an active one stay", async () => {
  const now = new Date("2026-11-16T05:00:00.000Z");
  const { db, tenant } = await controlPlane();
  tenant("t-1", "active", null);
  const host = (name: string, status: string, days: number, cfId: string | null) =>
    db.sqlite
      .prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, cf_custom_hostname_id, is_primary, created_at) VALUES (?, 't-1', 'custom', ?, ?, 0, ?)")
      .run(name, status, cfId, new Date(now.getTime() - days * DAY).toISOString());
  host("stale.example", "pending", 8, "cf-stale");
  host("fresh.example", "pending", 6, "cf-fresh");
  host("live.example", "active", 30, "cf-live");
  host("broken.example", "pending", 9, "cf-broken");

  const deleted: string[] = [];
  const original = console.error;
  console.error = () => undefined;
  let result;
  try {
    result = await runPlatformJobs(db, now, async (id) => {
      if (id === "cf-broken") throw new Error("Cloudflare 500");
      deleted.push(id);
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual(deleted, ["cf-stale"]);
  assert.equal(result.staleHostnames, 1);
  const status = (name: string) => (db.sqlite.prepare("SELECT status FROM tenant_hosts WHERE host = ?").get(name) as { status: string }).status;
  assert.equal(status("stale.example"), "revoked");
  assert.equal(status("fresh.example"), "pending");
  assert.equal(status("live.example"), "active");
  assert.equal(status("broken.example"), "pending", "a failed Cloudflare delete keeps our record for the next run");

  // Without a Cloudflare client nothing is reaped, and the run says so.
  const skipped = await runPlatformJobs(db, now);
  assert.equal(skipped.hostnameReapSkipped, true);
  assert.equal(status("broken.example"), "pending");
});

test("PRIV-4: a tenant whose purge_after has passed starts purging, with an audit row; one a day early does not", async () => {
  const now = new Date("2026-11-16T05:00:00.000Z");
  const { db, tenant } = await controlPlane();
  tenant("due", "suspended", new Date(now.getTime() - DAY).toISOString());
  tenant("early", "suspended", new Date(now.getTime() + DAY).toISOString());
  tenant("kept", "active", null);
  tenant("done", "purged", new Date(now.getTime() - 30 * DAY).toISOString());
  const result = await runPlatformJobs(db, now);
  assert.equal(result.purgesStarted, 1);
  const statuses = Object.fromEntries(
    db.sqlite.prepare("SELECT id, status FROM tenants").all().map((row) => [(row as { id: string }).id, (row as { status: string }).status]),
  );
  assert.deepEqual(statuses, { due: "purging", early: "suspended", kept: "active", done: "purged" });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM tenant_events WHERE tenant_id = 'due' AND kind = 'purge_started'"), 1);
  // Idempotent: a second run starts nothing new.
  assert.equal((await runPlatformJobs(db, now)).purgesStarted, 0);
});
