// T-25: the custom-hostname lifecycle against a Cloudflare stand-in that
// speaks the API's own envelope, through the real client.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import {
  claimDomain,
  cloudflareHostnameApi,
  deleteHostnameRef,
  explainValidationErrors,
  listDomains,
  planClaim,
  probeAnswer,
  probeHost,
  refreshDomain,
  removeDomain,
  replaceDomain,
  setPrimaryDomain,
} from "./hostnames.ts";
import { createFakeCloudflare } from "./testing/fake-cloudflare.ts";
import { runPlatformJobs } from "./jobs.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";
import { primaryHostRedirect } from "./host.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));

async function setup() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  for (const id of ["t-a", "t-b"]) {
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, 'active', '2026-11-16')").run(id, id, `${id}@example.test`);
    db.sqlite
      .prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, '2026-11-16')")
      .run(`${id}.adsbook.cc`, id);
  }
  const cloudflare = createFakeCloudflare();
  const api = cloudflareHostnameApi({ zoneId: cloudflare.zoneId, token: cloudflare.token, base: "https://cf.test/client/v4", fetcher: cloudflare.fetch });
  const row = (host: string) =>
    ({ ...(db.sqlite.prepare("SELECT tenant_id, status, cf_custom_hostname_id AS cf, is_primary, quarantine_until FROM tenant_hosts WHERE host = ?").get(host) as object) }) as {
      tenant_id: string; status: string; cf: string | null; is_primary: number; quarantine_until: string | null;
    };
  const cacheVersion = (id: string) => (db.sqlite.prepare("SELECT cache_version AS v FROM tenants WHERE id = ?").get(id) as { v: number }).v;
  return { db, cloudflare, api, row, cacheVersion };
}

test("HOST-4: the zone, the platform domain, their subdomains and hosts over 64 characters are refused with no API call", async () => {
  const { db, cloudflare, api } = await setup();
  for (const host of ["adsbook.cc", "toko.adsbook.cc", "adsbook.id", "app.adsbook.id", `${"a".repeat(61)}.com`, "not a host", "localhost"]) {
    const result = await claimDomain(db, api, "t-a", host, "subdomain");
    assert.equal(result.ok, false, host);
    if (!result.ok) assert.equal(result.status, 422, host);
  }
  // Exactly 64 characters is the limit, not over it.
  assert.equal(planClaim(`${"a".repeat(60)}.com`, "subdomain").ok, true);
  // A root claim whose `www.` would exceed 64 characters is refused too.
  assert.equal(planClaim(`${"a".repeat(57)}.com`, "root").ok, false);
  assert.equal(cloudflare.calls.length, 0, "a refused claim reached Cloudflare");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenant_hosts WHERE kind = 'custom'").get() as { n: number }).n, 0);
});

test("create → pending with the merchant's message → active only when both states are active (DOM-4)", async () => {
  const { db, cloudflare, api, row, cacheVersion } = await setup();
  const claimed = await claimDomain(db, api, "t-a", "https://TokoSaya.com/", "root");
  assert.ok(claimed.ok);
  assert.deepEqual(claimed.value.map((domain) => domain.host).sort(), ["tokosaya.com", "www.tokosaya.com"]);
  const post = cloudflare.calls.find((call) => call.method === "POST");
  assert.deepEqual((post?.body as { ssl: unknown }).ssl, { method: "http", type: "dv", settings: { min_tls_version: "1.2" } });
  assert.equal(row("tokosaya.com").status, "pending");
  assert.ok(row("tokosaya.com").cf);

  const pending = await refreshDomain(db, api, "t-a", "tokosaya.com");
  assert.ok(pending.ok);
  assert.equal(pending.value.status, "pending");
  assert.match(pending.value.errors[0], /DNS belum mengarah ke cname\.adsbook\.cc/);

  // Hostname active but certificate still issuing: no routing yet.
  cloudflare.activate("tokosaya.com", "pending_validation");
  assert.equal((await refreshDomain(db, api, "t-a", "tokosaya.com")).ok, true);
  assert.equal(row("tokosaya.com").status, "pending");

  const before = cacheVersion("t-a");
  cloudflare.activate("tokosaya.com");
  const active = await refreshDomain(db, api, "t-a", "tokosaya.com", { recheck: true });
  assert.ok(active.ok);
  assert.equal(active.value.status, "active");
  assert.equal(row("tokosaya.com").status, "active");
  assert.equal(cacheVersion("t-a"), before + 1, "activation bumps the cache version");
  assert.ok(cloudflare.calls.some((call) => call.method === "PATCH"), "Cek lagi restarts validation");

  // Another tenant cannot read or act on it.
  assert.equal((await refreshDomain(db, api, "t-b", "tokosaya.com")).ok, false);
  assert.equal((await removeDomain(db, api, "t-b", "tokosaya.com")).ok, false);
});

test("a Cloudflare refusal leaves nothing behind and is shown to the merchant", async () => {
  const { db, cloudflare, api } = await setup();
  cloudflare.refuse.set("www.ditolak.com", { code: 1469, message: "Hostname is too long for a certificate." });
  const result = await claimDomain(db, api, "t-a", "ditolak.com", "root");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 502);
    assert.match(result.error, /Cloudflare menolak domain ini/);
  }
  assert.equal(cloudflare.byHost("ditolak.com"), undefined, "the half-created apex was deleted at Cloudflare");
  assert.deepEqual((await listDomains(db, "t-a")).filter((domain) => domain.kind === "custom"), []);
});

test("HOST-2 / DATA-6: two tenants claiming one host concurrently — exactly one wins; duplicates and the cap are refused", async () => {
  const { db, cloudflare, api, row } = await setup();
  const [a, b] = await Promise.all([
    claimDomain(db, api, "t-a", "rebutan.com", "subdomain"),
    claimDomain(db, api, "t-b", "rebutan.com", "subdomain"),
  ]);
  assert.equal([a, b].filter((result) => result.ok).length, 1);
  const loser = [a, b].find((result) => !result.ok);
  assert.ok(loser && !loser.ok && loser.status === 409);
  assert.equal(cloudflare.calls.filter((call) => call.method === "POST").length, 1, "only the winner reached Cloudflare");
  const winner = row("rebutan.com").tenant_id;
  assert.equal((await claimDomain(db, api, winner, "rebutan.com", "subdomain")).ok, false, "the same tenant twice");

  // Pilot plan: one custom domain per store (Paduka, 2026-11-16); a second domain is another store.
  const capped = await claimDomain(db, api, winner, "kedua.com", "root");
  assert.equal(capped.ok, false);
  if (!capped.ok) {
    assert.equal(capped.status, 409);
    assert.match(capped.error, /^1 akun toko berlaku untuk 1 domain sendiri/);
    assert.match(capped.error, /buka toko baru \(berlangganan lagi\)/);
  }
});

test("DOM-5: removal revokes, quarantines, moves the primary back and deletes at Cloudflare", async () => {
  const { db, cloudflare, api, row, cacheVersion } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "hapus.com", "root")).ok);
  cloudflare.activate("hapus.com");
  await refreshDomain(db, api, "t-a", "hapus.com");
  assert.ok((await setPrimaryDomain(db, "t-a", "hapus.com", async () => true)).ok);
  assert.equal(row("hapus.com").is_primary, 1);
  assert.equal(row("t-a.adsbook.cc").is_primary, 0);

  const before = cacheVersion("t-a");
  const now = new Date("2026-11-16T05:00:00.000Z");
  const removed = await removeDomain(db, api, "t-a", "www.hapus.com", now);
  assert.ok(removed.ok);
  assert.deepEqual(removed.value.removed.sort(), ["hapus.com", "www.hapus.com"]);
  assert.equal(row("hapus.com").status, "revoked");
  assert.equal(row("hapus.com").cf, null, "deleted at Cloudflare, id cleared");
  assert.equal(cloudflare.byHost("hapus.com"), undefined);
  assert.equal(cloudflare.byHost("www.hapus.com"), undefined);
  assert.equal(row("t-a.adsbook.cc").is_primary, 1, "the platform subdomain is primary again");
  assert.ok(cacheVersion("t-a") > before);

  // Quarantined: no one claims it for a minute; then it can be claimed again.
  const early = await claimDomain(db, api, "t-b", "hapus.com", "subdomain", new Date(now.getTime() + 30_000));
  assert.equal(early.ok, false);
  assert.ok((await claimDomain(db, api, "t-b", "hapus.com", "subdomain", new Date(now.getTime() + 61_000))).ok);
});

test("a custom host becomes primary only after its HTTPS probe answers this tenant; pending hosts never", async () => {
  const { db, cloudflare, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "probe.com", "subdomain")).ok);
  assert.equal((await setPrimaryDomain(db, "t-a", "probe.com", async () => true)).ok, false, "a pending host");
  cloudflare.activate("probe.com");
  await refreshDomain(db, api, "t-a", "probe.com");
  const failed = await setPrimaryDomain(db, "t-a", "probe.com", async () => false);
  assert.equal(failed.ok, false);
  assert.equal(row("t-a.adsbook.cc").is_primary, 1, "a failed probe keeps the old primary");
  assert.ok((await setPrimaryDomain(db, "t-a", "probe.com", async () => true)).ok);
  assert.equal(row("probe.com").is_primary, 1);
});

test("the probe proof is an HMAC under the tenant's own key, bound to host and nonce (T-25 review)", async () => {
  const secret = "k".repeat(64);
  const nonce = "0".repeat(32);
  const answer = await probeAnswer(secret, "toko.com", nonce);
  assert.notEqual(answer, await probeAnswer(secret, "lain.com", nonce), "bound to the host");
  assert.notEqual(answer, await probeAnswer(secret, "toko.com", "1".repeat(32)), "bound to the nonce");
  assert.notEqual(answer, await probeAnswer("x".repeat(64), "toko.com", nonce), "bound to the key");
  // A host that answers with the right key passes; a replayed or foreign answer fails.
  const honest = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return new Response(await probeAnswer(secret, url.hostname, url.searchParams.get("n") ?? ""));
  }) as typeof fetch;
  assert.equal(await probeHost("toko.com", secret, honest), true);
  const replay = (async () => new Response(answer)) as typeof fetch;
  assert.equal(await probeHost("toko.com", secret, replay), false, "a fixed answer cannot pass a fresh nonce");
  assert.equal(await probeHost("toko.com", "", honest), false, "no key, no promotion");
});

test("concurrent claims for different domains cannot pass the plan cap together (T-25 review)", async () => {
  const { db, api } = await setup();
  // Pilot cap 1, none used: two parallel claims race for the only slot.
  const results = await Promise.all([
    claimDomain(db, api, "t-a", "dua.com", "root"),
    claimDomain(db, api, "t-a", "tiga.com", "root"),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const groups = db.sqlite.prepare("SELECT COUNT(DISTINCT domain_group) AS n FROM tenant_hosts WHERE tenant_id = 't-a' AND kind = 'custom' AND status != 'revoked'").get() as { n: number };
  assert.equal(groups.n, 1);
});

test("a host revoked into quarantine between the claim's check and its write is never replaced (T-25 review)", async () => {
  const { db, api, row } = await setup();
  const now = new Date("2026-11-16T05:00:00.000Z");
  db.sqlite
    .prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at) VALUES ('karantina.com', 't-a', 'custom', 'karantina.com', 'active', 0, '2026-11-01')")
    .run();
  // Tenant A removes the host after B's pre-check passed and before B's batch runs.
  const batch = db.batch.bind(db);
  db.batch = (async (statements: D1PreparedStatement[]) => {
    db.sqlite
      .prepare("UPDATE tenant_hosts SET status = 'revoked', quarantine_until = ? WHERE host = 'karantina.com'")
      .run(new Date(now.getTime() + 30_000).toISOString());
    db.batch = batch;
    return batch(statements);
  }) as typeof db.batch;
  const result = await claimDomain(db, api, "t-b", "karantina.com", "subdomain", now);
  assert.equal(result.ok, false);
  assert.equal(row("karantina.com").tenant_id, "t-a", "the quarantined row was replaced");
});

test("a failed rollback keeps the Cloudflare id on a revoked row for the reaper (T-25 review)", async () => {
  const { db, cloudflare, api, row } = await setup();
  cloudflare.refuse.set("www.separuh.com", { code: 1000, message: "boom" });
  const failingRemove = { ...api, remove: async () => { throw new Error("Cloudflare down"); } };
  const original = console.error;
  console.error = () => undefined;
  try {
    const result = await claimDomain(db, failingRemove, "t-a", "separuh.com", "root");
    assert.equal(result.ok, false);
  } finally {
    console.error = original;
  }
  assert.equal(row("separuh.com").status, "revoked");
  assert.ok(row("separuh.com").cf, "the billable hostname is still tracked");
  assert.equal(db.sqlite.prepare("SELECT 1 FROM tenant_hosts WHERE host = 'www.separuh.com'").get(), undefined);
});

test("a host removed while its probe runs never leaves the tenant without a primary (T-25 review)", async () => {
  const { db, cloudflare, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "balapan.com", "subdomain")).ok);
  cloudflare.activate("balapan.com");
  await refreshDomain(db, api, "t-a", "balapan.com");
  const result = await setPrimaryDomain(db, "t-a", "balapan.com", async () => {
    await removeDomain(db, api, "t-a", "balapan.com");
    return true;
  });
  assert.equal(result.ok, false);
  assert.equal(row("t-a.adsbook.cc").is_primary, 1);
});

test("internal errors never reach the merchant verbatim (T-25 review)", async () => {
  const { db, cloudflare, api } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "rahasia.com", "subdomain")).ok);
  const broken = { ...api, get: async () => { throw new Error("D1_ERROR: internal detail /var/secret"); } };
  const original = console.error;
  console.error = () => undefined;
  try {
    const result = await refreshDomain(db, broken, "t-a", "rahasia.com");
    assert.equal(result.ok, false);
    if (!result.ok) assert.doesNotMatch(result.error, /D1_ERROR|secret/);
  } finally {
    console.error = original;
  }
  assert.ok(cloudflare.byHost("rahasia.com"));
});

test("validation messages are translated with the remedy", () => {
  const messages = explainValidationErrors({
    id: "x",
    hostname: "x.com",
    status: "pending",
    ssl: { status: "pending_validation", validation_errors: [{ message: "CAA record prevents issuance" }] },
    verification_errors: ["custom hostname does not CNAME to this zone."],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /CNAME/);
  assert.match(messages[1], /CAA/);
});

test("a create Cloudflare accepted is deleted even when our write of its id fails, or its answer was lost (T-25 review 2)", async () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    // D1 loses the id write: the in-memory id still deletes it.
    {
      const { db, cloudflare, api } = await setup();
      db.failWhen = /SET cf_custom_hostname_id = \?, ssl_status/;
      const result = await claimDomain(db, api, "t-a", "tulisgagal.com", "subdomain");
      db.failWhen = null;
      assert.equal(result.ok, false);
      assert.equal(cloudflare.byHost("tulisgagal.com"), undefined, "a billable hostname was orphaned");
      assert.equal(db.sqlite.prepare("SELECT 1 FROM tenant_hosts WHERE host = 'tulisgagal.com'").get(), undefined);
    }
    // The create succeeded at Cloudflare but the answer timed out: found by name, deleted.
    {
      const { db, cloudflare, api } = await setup();
      const lost = { ...api, create: async (hostname: string) => { await api.create(hostname); throw new Error("timeout"); } };
      assert.equal((await claimDomain(db, lost, "t-a", "hilang.com", "subdomain")).ok, false);
      assert.equal(cloudflare.byHost("hilang.com"), undefined);
    }
    // The lookup itself fails: the row is kept (revoked), never dropped on a guess.
    {
      const { db, api, row } = await setup();
      const blind = {
        ...api,
        create: async () => { throw new Error("timeout"); },
        findByHostname: async () => { throw new Error("Cloudflare down"); },
      };
      assert.equal((await claimDomain(db, blind, "t-a", "buta.com", "subdomain")).ok, false);
      assert.equal(row("buta.com").status, "revoked");
      assert.equal(row("buta.com").cf, "lookup:buta.com", "the unknown hostname stays referenced");
      // Nobody can re-claim it while Cloudflare's state is unknown (T-25 review 3).
      assert.equal((await claimDomain(db, api, "t-b", "buta.com", "subdomain", new Date(Date.now() + 3_600_000))).ok, false);
      assert.equal(row("buta.com").tenant_id, "t-a");
      // The platform job resolves it by name and clears the reference.
      await runPlatformJobs(db, new Date(), (reference) => deleteHostnameRef(api, reference));
      assert.equal(row("buta.com").cf, null);
    }
  } finally {
    console.error = original;
  }
});

test("a promotion landing between a removal's read and its write still leaves a primary (T-25 review 2)", async () => {
  const { db, cloudflare, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "susul.com", "subdomain")).ok);
  cloudflare.activate("susul.com");
  await refreshDomain(db, api, "t-a", "susul.com");
  // Promote right before the removal's batch runs.
  const batch = db.batch.bind(db);
  db.batch = (async (statements: D1PreparedStatement[]) => {
    db.batch = batch;
    db.sqlite.exec("UPDATE tenant_hosts SET is_primary = 0 WHERE tenant_id = 't-a'; UPDATE tenant_hosts SET is_primary = 1 WHERE host = 'susul.com'");
    return batch(statements);
  }) as typeof db.batch;
  assert.ok((await removeDomain(db, api, "t-a", "susul.com")).ok);
  assert.equal(row("t-a.adsbook.cc").is_primary, 1, "the tenant was left without a primary");
});

test("an internal failure while reserving is a logged 500, not a false conflict (T-25 review 2)", async () => {
  const { db, api } = await setup();
  const logged: string[] = [];
  const original = console.error;
  console.error = (label: unknown) => void logged.push(String(label));
  db.failWhen = /INSERT INTO tenant_hosts/;
  try {
    const result = await claimDomain(db, api, "t-a", "rusak.com", "subdomain");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.doesNotMatch(result.error, /D1|injected/);
    }
  } finally {
    db.failWhen = null;
    console.error = original;
  }
  assert.ok(logged.includes("hostname-claim-reserve-failed"));
});

test("a root claim's first hostname cannot be activated while the second is still being created (T-25 review 3)", async () => {
  const { db, cloudflare, api, row } = await setup();
  let midClaim: Awaited<ReturnType<typeof refreshDomain>> | null = null;
  const racing = {
    ...api,
    create: async (hostname: string) => {
      if (hostname === "www.balap.com") {
        // The apex is already live at Cloudflare; a refresh lands now.
        cloudflare.activate("balap.com");
        midClaim = await refreshDomain(db, api, "t-a", "balap.com");
        throw new Error("timeout");
      }
      return api.create(hostname);
    },
  };
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await claimDomain(db, racing, "t-a", "balap.com", "root")).ok, false);
  } finally {
    console.error = original;
  }
  assert.ok(midClaim && !(midClaim as { ok: boolean }).ok, "a mid-claim refresh found nothing to activate");
  assert.equal(db.sqlite.prepare("SELECT 1 FROM tenant_hosts WHERE host = 'balap.com' AND status = 'active'").get(), undefined);
  assert.equal(cloudflare.byHost("balap.com"), undefined, "rolled back at Cloudflare");
  assert.equal(row("t-a.adsbook.cc").is_primary, 1);
});

test("a removal landing while Cloudflare creates the claim's hostnames still deletes them (T-25 review 4)", async () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    for (const removeFails of [false, true]) {
      const { db, cloudflare, api, row } = await setup();
      const host = removeFails ? "hapus-gagal.com" : "hapus-tengah.com";
      const racing = {
        ...api,
        remove: removeFails ? async () => { throw new Error("Cloudflare down"); } : api.remove,
        create: async (hostname: string) => {
          const created = await api.create(hostname);
          await removeDomain(db, api, "t-a", hostname); // the owner removes it mid-claim
          return created;
        },
      };
      assert.equal((await claimDomain(db, racing, "t-a", host, "subdomain")).ok, false);
      if (removeFails) {
        assert.ok(row(host).cf, "the revoked row keeps the reference for the reaper");
      } else {
        assert.equal(cloudflare.byHost(host), undefined, "orphaned at Cloudflare");
      }
    }
  } finally {
    console.error = original;
  }
});

test("a partly written claim whose rollback delete fails leaves no pending row holding a Cloudflare id (T-25 review 5)", async () => {
  const { db, cloudflare, api, row } = await setup();
  const original = console.error;
  console.error = () => undefined;
  // The www row is revoked between the creates and the id write; Cloudflare then refuses every delete.
  const racing = {
    ...api,
    remove: async () => { throw new Error("Cloudflare down"); },
    create: async (hostname: string) => {
      const created = await api.create(hostname);
      if (hostname === "www.sebagian.com") {
        db.sqlite.prepare("UPDATE tenant_hosts SET status = 'revoked' WHERE host = 'www.sebagian.com'").run();
      }
      return created;
    },
  };
  try {
    assert.equal((await claimDomain(db, racing, "t-a", "sebagian.com", "root")).ok, false);
  } finally {
    console.error = original;
  }
  for (const host of ["sebagian.com", "www.sebagian.com"]) {
    assert.equal(row(host).status, "revoked", `${host} left pending`);
    assert.equal(row(host).cf, cloudflare.byHost(host)?.id, `${host} keeps its own reference for the reaper`);
  }
});

test("T-43/PR-28: switching branches reuses the `www` hostname both ways; the cap counts the domain once", async () => {
  const { db, cloudflare, api, row } = await setup();
  const posts = () => cloudflare.calls.filter((call) => call.method === "POST").length;
  const deletes = () => cloudflare.calls.filter((call) => call.method === "DELETE").map((call) => call.path);

  // `www` primary first (the seller's DNS cannot point the root).
  assert.ok((await claimDomain(db, api, "t-a", "merchant.com", "www")).ok);
  const wwwId = row("www.merchant.com").cf;
  assert.ok(wwwId);
  assert.equal(posts(), 1);

  // Then the root branch: only the root is created; the `www` row stays as it is.
  db.sqlite.exec("UPDATE plans SET max_custom_domains = 1");
  const root = await claimDomain(db, api, "t-a", "merchant.com", "root");
  assert.ok(root.ok, root.ok ? "" : root.error);
  assert.equal(posts(), 2, "one Cloudflare create, for the root only");
  assert.equal(row("www.merchant.com").cf, wwwId, "the www hostname is reused, not recreated");
  assert.equal(row("merchant.com").status, "pending");
  assert.equal((await claimDomain(db, api, "t-a", "merchant.com", "root")).ok, false, "nothing new to add is a conflict");

  // And back to `www` only: the root alone is removed (and deleted at Cloudflare).
  const rootId = row("merchant.com").cf;
  const removed = await removeDomain(db, api, "t-a", "merchant.com", new Date(), "host");
  assert.ok(removed.ok);
  assert.deepEqual(removed.ok && removed.value.removed, ["merchant.com"]);
  assert.equal(row("merchant.com").status, "revoked");
  assert.equal(row("www.merchant.com").status, "pending", "www is untouched");
  assert.equal(row("www.merchant.com").cf, wwwId);
  assert.ok(deletes().some((path) => path.endsWith(`/${rootId}`)));
  assert.ok(!deletes().some((path) => path.endsWith(`/${wwwId}`)), "the www hostname is not deleted at Cloudflare");
});

test("T-43 review: host-scope removal is only the root of a group that keeps its www", async () => {
  const { db, api, row } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "contoh.com", "root")).ok);
  // Removing www alone while the root stays is refused; nothing changes.
  const refused = await removeDomain(db, api, "t-a", "www.contoh.com", new Date(), "host");
  assert.equal(refused.ok, false);
  assert.equal(row("www.contoh.com").status, "pending");
  // A root without a live www cannot be removed alone either (no Cloudflare delete).
  db.sqlite.exec("UPDATE tenant_hosts SET status = 'revoked' WHERE host = 'www.contoh.com'");
  const lone = await removeDomain(db, api, "t-a", "contoh.com", new Date(), "host");
  assert.equal(lone.ok, false);
  assert.equal(row("contoh.com").status, "pending", "nothing revoked");
  assert.ok(row("contoh.com").cf, "its Cloudflare hostname is untouched");
});

test("T-43 review: the claim batch itself refuses when a reused host is gone (no lone root)", async () => {
  const { db, api } = await setup();
  assert.ok((await claimDomain(db, api, "t-a", "lain.com", "www")).ok);
  // Revoke www inside the window: wrap the batch so the revocation lands just before it.
  const batch = db.batch.bind(db);
  let once = true;
  (db as { batch: typeof db.batch }).batch = async (statements) => {
    if (once) {
      once = false;
      db.sqlite.exec("UPDATE tenant_hosts SET status = 'revoked', quarantine_until = '2999-01-01' WHERE host = 'www.lain.com'");
    }
    return batch(statements);
  };
  const result = await claimDomain(db, api, "t-a", "lain.com", "root");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /berubah/);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenant_hosts WHERE host = 'lain.com'").get() as { n: number }).n, 0, "no lone root row");
});

// ---- Paduka 2026-11-16: "seller juga di izinkan edit/replace domain" ----

/** A tenant selling on its own active primary domain `lama.com` (root + www). */
async function sellingOn(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { db, cloudflare, api } = setupResult;
  assert.ok((await claimDomain(db, api, "t-a", "lama.com", "root")).ok);
  cloudflare.activate("lama.com");
  cloudflare.activate("www.lama.com");
  await refreshDomain(db, api, "t-a", "lama.com");
  await refreshDomain(db, api, "t-a", "www.lama.com");
  assert.ok((await setPrimaryDomain(db, "t-a", "lama.com", async () => true)).ok);
}

test("replace: an invalid, platform, over-long, taken or quarantined new domain leaves the working domain untouched", async () => {
  const ctx = await setup();
  const { db, cloudflare, api, row } = ctx;
  await sellingOn(ctx);
  const before = JSON.stringify([row("lama.com"), row("www.lama.com")]);
  const deletes = () => cloudflare.calls.filter((call) => call.method === "DELETE").length;
  // Another store holds one host; another just released one (quarantine).
  assert.ok((await claimDomain(db, api, "t-b", "milik-b.com", "subdomain")).ok);
  db.sqlite
    .prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, domain_group, status, is_primary, created_at, revoked_at, quarantine_until) VALUES ('baru-dilepas.com', 't-b', 'custom', 'baru-dilepas.com', 'revoked', 0, '2026-11-01', '2026-11-16', '2999-01-01')")
    .run();
  for (const [host, mode, status] of [
    ["bukan domain", "root", 422],
    ["toko.adsbook.cc", "subdomain", 422],
    ["app.adsbook.id", "subdomain", 422],
    [`${"a".repeat(57)}.com`, "root", 422],
    ["milik-b.com", "subdomain", 409],
    ["baru-dilepas.com", "subdomain", 409],
  ] as const) {
    const result = await replaceDomain(db, api, "t-a", host, mode);
    assert.equal(result.ok, false, host);
    if (!result.ok) assert.equal(result.status, status, host);
  }
  assert.equal(JSON.stringify([row("lama.com"), row("www.lama.com")]), before, "the working domain is exactly as it was");
  assert.equal(row("lama.com").is_primary, 1);
  assert.equal(deletes(), 0, "nothing was deleted at Cloudflare");
});

test("replace: a valid new domain revokes and deletes the old one, the subdomain serves meanwhile, and one group remains", async () => {
  const ctx = await setup();
  const { db, cloudflare, api, row } = ctx;
  await sellingOn(ctx);
  const oldIds = [row("lama.com").cf, row("www.lama.com").cf];
  // Without `replace` a second domain is refused and points at "Ganti domain".
  const added = await claimDomain(db, api, "t-a", "baru.com", "root");
  assert.equal(added.ok, false);
  if (!added.ok) assert.match(added.error, /Ganti domain/);

  const replaced = await replaceDomain(db, api, "t-a", "baru.com", "root");
  assert.ok(replaced.ok, replaced.ok ? "" : replaced.error);
  for (const host of ["lama.com", "www.lama.com"]) {
    assert.equal(row(host).status, "revoked", host);
    assert.equal(row(host).cf, null, `${host} deleted at Cloudflare`);
    assert.ok(row(host).quarantine_until, `${host} quarantined`);
  }
  const deleted = cloudflare.calls.filter((call) => call.method === "DELETE").map((call) => call.path.split("/").pop());
  assert.deepEqual(deleted.sort(), [...oldIds].sort());
  assert.equal(row("t-a.adsbook.cc").is_primary, 1, "the subdomain is the primary until the new domain is active");
  assert.equal(row("baru.com").status, "pending");
  assert.equal(row("www.baru.com").status, "pending");
  const groups = db.sqlite.prepare("SELECT COUNT(DISTINCT domain_group) AS n FROM tenant_hosts WHERE tenant_id = 't-a' AND kind = 'custom' AND status != 'revoked'").get() as { n: number };
  assert.equal(groups.n, 1, "never more than one domain group");
  // The same domain under another mode is a branch switch, not a replacement: nothing is removed.
  const switched = await replaceDomain(db, api, "t-a", "baru.com", "www");
  assert.equal(switched.ok, false, "www is already part of the root claim");
  assert.equal(row("baru.com").status, "pending", "the root stays");
});

test("301 to the active custom primary: www and the store's subdomain move, APIs, sign-in, recovery, admin and well-known stay", () => {
  type Tenant = { hostKind: "custom" | "subdomain"; primaryHost: string | null };
  const custom: Tenant = { hostKind: "custom", primaryHost: "domain.com" };
  const sub: Tenant = { hostKind: "subdomain", primaryHost: "domain.com" };
  const at = (href: string, tenant: Tenant, method = "GET") => primaryHostRedirect(new URL(href), method, tenant);
  assert.equal(at("https://tokodia.adsbook.cc/produk/x?fbclid=123", sub), "https://domain.com/produk/x?fbclid=123");
  assert.equal(at("https://www.domain.com/produk/x?fbclid=123", custom), "https://domain.com/produk/x?fbclid=123");
  assert.equal(at("https://tokodia.adsbook.cc/?utm_source=fb&gclid=g", sub, "HEAD"), "https://domain.com/?utm_source=fb&gclid=g");
  assert.equal(at("https://domain.com/produk/x", custom), null, "the primary serves");
  for (const path of ["/api/webhooks/autolaris/tok", "/api/handoff", "/api/owner-recovery", "/api/submit-order", "/pemulihan", "/hello", "/admin", "/admin/orders", "/.well-known/adsbook-probe"]) {
    assert.equal(at(`https://tokodia.adsbook.cc${path}`, sub), null, path);
  }
  assert.equal(at("https://tokodia.adsbook.cc/produk/x", sub, "POST"), null, "only GET and HEAD");
  // No custom primary (none yet, or removed/replaced): the subdomain serves the store.
  assert.equal(at("https://tokodia.adsbook.cc/produk/x", { hostKind: "subdomain", primaryHost: "tokodia.adsbook.cc" }), null);
  assert.equal(at("https://tokodia.adsbook.cc/produk/x", { hostKind: "subdomain", primaryHost: null }), null);
});
