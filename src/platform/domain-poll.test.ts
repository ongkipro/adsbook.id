// Paduka 2026-11-16: one domain per store goes live without a second click —
// the whole group refreshes together, an active domain is promoted after its
// probe, and the platform cron does it for sellers who closed the tab.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import { canonicalMember, pollPendingDomains, promoteGroupIfReady, refreshDomainGroup } from "./domain-poll.ts";
import { claimDomain, cloudflareHostnameApi } from "./hostnames.ts";
import { createFakeCloudflare } from "./testing/fake-cloudflare.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

async function setup() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  for (const id of ["t-a", "t-b"]) {
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, 'active', '2026-11-16')").run(id, id, `${id}@example.test`);
    db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, '2026-11-16')").run(`${id}.adsbook.cc`, id);
  }
  const cloudflare = createFakeCloudflare();
  const api = cloudflareHostnameApi({ zoneId: cloudflare.zoneId, token: cloudflare.token, base: "https://cf.test/client/v4", fetcher: cloudflare.fetch });
  const row = (host: string) => ({ ...(db.sqlite.prepare("SELECT status, is_primary FROM tenant_hosts WHERE host = ?").get(host) as object) }) as { status: string; is_primary: number };
  return { db, cloudflare, api, row };
}

test("the canonical host of a group: the main domain when there is one, else its www", () => {
  assert.equal(canonicalMember("domain.com", [{ host: "domain.com" }, { host: "www.domain.com" }]), "domain.com");
  assert.equal(canonicalMember("domain.com", [{ host: "www.domain.com" }]), "www.domain.com");
  assert.equal(canonicalMember("toko.domain.com", [{ host: "toko.domain.com" }]), "toko.domain.com");
  assert.equal(canonicalMember("domain.com", []), null);
});

test("one 'Cek lagi' refreshes root and www together and makes the root primary once its probe answers", async () => {
  const { db, cloudflare, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "domain.com", "root")).ok);
  cloudflare.activate("domain.com");
  cloudflare.activate("www.domain.com");
  const refreshed = await refreshDomainGroup(db, api, "t-a", "www.domain.com", { recheck: true });
  assert.ok(refreshed.ok);
  assert.deepEqual(refreshed.ok && refreshed.value.map((view) => [view.host, view.status]).sort(), [["domain.com", "active"], ["www.domain.com", "active"]]);
  const probed: string[] = [];
  const promotion = await promoteGroupIfReady(db, "t-a", "www.domain.com", async (host) => (probed.push(host), true));
  assert.deepEqual(promotion, { outcome: "promoted", host: "domain.com" });
  assert.deepEqual(probed, ["domain.com"], "the root is the one probed and promoted");
  assert.equal(row("domain.com").is_primary, 1);
  assert.equal(row("t-a.adsbook.cc").is_primary, 0);
  assert.deepEqual(await promoteGroupIfReady(db, "t-a", "domain.com", async () => true), { outcome: "already-primary", host: "domain.com" });
});

test("a failed probe or a domain still pending changes nothing: the subdomain stays primary", async () => {
  const { db, cloudflare, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "domain.com", "root")).ok);
  assert.equal((await promoteGroupIfReady(db, "t-a", "domain.com", async () => true)).outcome, "not-ready");
  cloudflare.activate("domain.com");
  await refreshDomainGroup(db, api, "t-a", "domain.com");
  assert.equal((await promoteGroupIfReady(db, "t-a", "domain.com", async () => false)).outcome, "probe-failed");
  assert.equal(row("t-a.adsbook.cc").is_primary, 1);
  assert.equal(row("domain.com").is_primary, 0);
  // www-only: the www host is the one promoted.
  const other = await setup();
  assert.ok((await claimDomain(other.db, other.api, "t-b", "lain.com", "www")).ok);
  other.cloudflare.activate("www.lain.com");
  await refreshDomainGroup(other.db, other.api, "t-b", "www.lain.com");
  assert.deepEqual(await promoteGroupIfReady(other.db, "t-b", "www.lain.com", async () => true), { outcome: "promoted", host: "www.lain.com" });
});

test("the cron leg activates and promotes pending domains without the seller, bounded, skipping suspended stores and stores it cannot open", async () => {
  const { db, cloudflare, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "domain.com", "root")).ok);
  assert.ok((await claimDomain(db, api, "t-b", "kedua.com", "root")).ok);
  cloudflare.activate("domain.com");
  cloudflare.activate("www.domain.com");
  cloudflare.activate("kedua.com");
  const announced: string[] = [];
  const deps = {
    secretFor: async (tenantId: string) => (tenantId === "t-a" ? "secret-a" : null),
    probe: async (_host: string, secret: string) => secret === "secret-a",
    onActive: (_tenant: string, slug: string, view: { host: string }) => void announced.push(`${slug}:${view.host}`),
  };
  // Bounded: one group per run here.
  assert.deepEqual(await pollPendingDomains(db, api, deps, 1), { checked: 1, activated: 2, promoted: 1 });
  assert.equal(row("domain.com").is_primary, 1, "the oldest pending domain went live and became primary");
  assert.equal(row("kedua.com").status, "pending", "the second waits for the next run");
  // Next run: t-b's store cannot be opened, so its domain activates but is not promoted.
  const next = await pollPendingDomains(db, api, deps, 25);
  assert.equal(next.promoted, 0);
  assert.equal(row("kedua.com").status, "active");
  assert.equal(row("kedua.com").is_primary, 0);
  assert.ok(announced.includes("t-a:domain.com") && announced.includes("t-b:kedua.com"));
  // A suspended store's pending domain is not polled.
  db.sqlite.exec("UPDATE tenants SET status = 'suspended' WHERE id = 't-b'; UPDATE tenant_hosts SET status = 'pending' WHERE host = 'www.kedua.com'");
  assert.equal((await pollPendingDomains(db, api, deps, 25)).checked, 0);
});
