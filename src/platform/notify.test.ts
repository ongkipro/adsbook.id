// T-44 (PR-29): operator notices — once per event, never a buyer field.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import { noticeStuckDomains, noticeText, notifyOperator } from "./notify.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
const ENV = { PLATFORM_ALERT_WEBHOOK_URL: "https://hooks.example/notify", PLATFORM_ADMIN_URL: "https://app.adsbook.id" };

async function setup() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-a', 'toko-a', 'owner@toko-a.example', 'active', '2026-11-16')").run();
  const posts: Array<{ url: string; body: { text: string; content: string } }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("ok");
  }) as unknown as typeof fetch;
  return { db, posts, fetcher };
}

test("a notice is sent once per event, with name, slug and the admin link, in the alert body shape", async () => {
  const { db, posts, fetcher } = await setup();
  const notice = { tenantId: "t-a", slug: "toko-a", kind: "signup" as const, storeName: "Toko A" };
  assert.equal(await notifyOperator(ENV, db, notice, fetcher), "sent");
  assert.equal(await notifyOperator(ENV, db, notice, fetcher), "duplicate");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, ENV.PLATFORM_ALERT_WEBHOOK_URL);
  assert.equal(posts[0].body.text, posts[0].body.content, "text and content, as alertWebhookBody");
  assert.equal(posts[0].body.text, "[adsbook.id] Seller baru mendaftar: Toko A (toko-a) — https://app.adsbook.id/platform/tenants/t-a");
  assert.doesNotMatch(posts[0].body.text, /owner@/, "not even the seller's email");
  // One per host for domains.
  assert.equal(await notifyOperator(ENV, db, { ...notice, kind: "domain_active", host: "a.com" }, fetcher), "sent");
  assert.equal(await notifyOperator(ENV, db, { ...notice, kind: "domain_active", host: "b.com" }, fetcher), "sent");
  assert.equal(await notifyOperator(ENV, db, { ...notice, kind: "domain_active", host: "a.com" }, fetcher), "duplicate");
});

test("no webhook or a non-https one sends nothing and claims nothing; a failing webhook never throws", async () => {
  const { db, posts, fetcher } = await setup();
  const notice = { tenantId: "t-a", slug: "toko-a", kind: "ready" as const };
  assert.equal(await notifyOperator({}, db, notice, fetcher), "skipped");
  assert.equal(await notifyOperator({ PLATFORM_ALERT_WEBHOOK_URL: "http://hooks.example" }, db, notice, fetcher), "skipped");
  assert.equal(posts.length, 0);
  assert.equal(await notifyOperator(ENV, db, notice, fetcher), "sent", "a skipped notice was not claimed");
  const original = console.error;
  console.error = () => undefined;
  try {
    const failing = (async () => { throw new Error("network https://hooks.example/notify?token=secret"); }) as unknown as typeof fetch;
    assert.equal(await notifyOperator(ENV, db, { ...notice, kind: "first_order" }, failing), "failed");
  } finally {
    console.error = original;
  }
});

test("a custom domain still pending after 24 hours is announced once", async () => {
  const { db } = await setup();
  const now = new Date("2026-11-17T12:00:00Z");
  db.sqlite.exec(`INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at) VALUES
    ('lama.com', 't-a', 'custom', 'lama.com', 'pending', 0, '2026-11-16T10:00:00Z'),
    ('baru.com', 't-a', 'custom', 'baru.com', 'pending', 0, '2026-11-17T11:00:00Z'),
    ('aktif.com', 't-a', 'custom', 'aktif.com', 'active', 0, '2026-11-15T10:00:00Z')`);
  const originalFetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body)).text), new Response("ok"))) as typeof fetch;
  try {
    assert.equal(await noticeStuckDomains(ENV, db, now), 1);
    assert.equal(await noticeStuckDomains(ENV, db, now), 0, "once");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0], /belum aktif setelah 24 jam: toko-a \(toko-a\) · lama\.com/);
});

test("the notice text never carries more than its fields", () => {
  const text = noticeText(ENV, { tenantId: "t-a", slug: "toko-a", kind: "first_order", storeName: "Toko A" });
  assert.equal(text, "[adsbook.id] Pesanan pertama toko: Toko A (toko-a) — https://app.adsbook.id/platform/tenants/t-a");
});
