// The L0 bound-owner predicate (resolveBoundOwner) and the phase A check of a
// restored, fenced tenant (checkRestoredOwnerIdentity): fail closed, never a
// guess, read-only — and in agreement with IAM-9's own owner lookup.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_ADMIN_PASSWORD_HASH, getAdminCredential, hashAdminPassword, verifyAdminLoginPassword } from "../lib/admin-credentials.ts";
import { splitMigrationStatements } from "../lib/schema-version.ts";
import { redeemOwnerRecovery } from "./admin/recovery.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { prepareHandoff } from "./handoff.ts";
import { reconcileFencedTenantIdentities, syncTenantIdentities } from "./identities.ts";
import { checkPostSyncOwnerIdentity, checkRestoredOwnerIdentity, resolveBoundOwner, type BoundOwner, type OwnerCredentialRow } from "./owner-identity.ts";
import { applyMigrationFile, TenantStoreEngine, type MigrationFile, type StoreKv } from "./store-core.ts";
import { createTenantDb, restoreTenant, type TenantStoreStub } from "./tenant-db.ts";
import { createNodeStorage } from "./testing/node-storage.ts";
import { createSqliteD1, type SqliteD1 } from "./testing/sqlite-d1.ts";

const chainOf = (url: URL): MigrationFile[] =>
  readdirSync(url).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, url), "utf8") }));
const CHAIN = chainOf(new URL("../db/migrations/", import.meta.url));
const PLATFORM_CHAIN = chainOf(new URL("./migrations/", import.meta.url));
const TARGET = CHAIN.length;
const OWNER = "owner@toko-a.test";

// ── the pure predicate ──────────────────────────────────────────────────────
const row = (id: number, username: string, email: string | null, role = "admin", passwordHash = "pbkdf2-sha256$100000$x$y"): OwnerCredentialRow => ({ id, username, email, role, passwordHash });

test("resolveBoundOwner: exactly one claimed owner bound to owner_email by username, email or both", () => {
  assert.deepEqual(resolveBoundOwner(OWNER, [row(1, OWNER, OWNER, "owner"), row(2, "kasir", "kasir@toko-a.test")]), { owner: { credentialId: 1, boundBy: "both" } });
  assert.deepEqual(resolveBoundOwner(OWNER, [row(1, "renamed", OWNER, "owner")]), { owner: { credentialId: 1, boundBy: "email" } }, "a renamed owner is still bound by email");
  assert.deepEqual(resolveBoundOwner(OWNER, [row(4, OWNER, null, "owner")]), { owner: { credentialId: 4, boundBy: "username" } });
});

test("resolveBoundOwner: absent, multiple, unclaimed, unbound and shadowed owners are refused, never guessed", () => {
  const cases: Array<[string, string | null, OwnerCredentialRow[], string]> = [
    ["no owner row", OWNER, [row(2, OWNER, OWNER)], "no_owner"],
    ["empty store", OWNER, [], "no_owner"],
    ["two bound owners", OWNER, [row(1, OWNER, OWNER, "owner"), row(2, "other", OWNER, "owner")], "multiple_owners"],
    ["one bound and one unbound owner", OWNER, [row(1, OWNER, OWNER, "owner"), row(9, "x", null, "owner")], "multiple_owners"],
    ["seeded default owner (restore before the claim)", OWNER, [row(1, "admin", OWNER, "owner", DEFAULT_ADMIN_PASSWORD_HASH)], "owner_unclaimed"],
    ["renamed with no email", OWNER, [row(1, "renamed", null, "owner")], "owner_unbound"],
    ["email changed", OWNER, [row(1, "renamed", "elsewhere@toko-a.test", "owner")], "owner_unbound"],
    ["case differs (exact comparison, as IAM-9)", OWNER, [row(1, "Owner@Toko-A.test", "Owner@Toko-A.test", "owner")], "owner_unbound"],
    ["surrounding space", OWNER, [row(1, ` ${OWNER}`, `${OWNER} `, "owner")], "owner_unbound"],
    ["no owner_email", "", [row(1, "", "", "owner")], "owner_unbound"],
    ["null owner_email", null, [row(1, OWNER, OWNER, "owner")], "owner_unbound"],
    ["staff username carries the owner address", OWNER, [row(1, "renamed", OWNER, "owner"), row(2, OWNER, null)], "owner_email_shadowed"],
    ["staff email carries the owner address", OWNER, [row(1, OWNER, null, "owner"), row(2, "kasir", OWNER)], "owner_email_shadowed"],
  ];
  for (const [name, email, credentials, reason] of cases) {
    assert.deepEqual(resolveBoundOwner(email, credentials), { reason }, name);
    assert.deepEqual(resolveBoundOwner(email, [...credentials].reverse()), { reason }, `${name} (order never decides)`);
  }
});

test("resolveBoundOwner: the answer carries ids and codes only", () => {
  const ok = resolveBoundOwner(OWNER, [row(1, OWNER, OWNER, "owner", "pbkdf2-sha256$100000$secret-salt$secret-hash")]);
  const text = JSON.stringify(ok);
  for (const leaked of [OWNER, "secret"]) assert.ok(!text.includes(leaked), `no ${leaked} in the result`);
});

// ── the phase A check over a real store and control plane ──────────────────
function memoryKv(): StoreKv {
  const values = new Map<string, unknown>();
  return { get: (key) => values.get(key), put: (key, value) => void values.set(key, value), delete: (key) => void values.delete(key) };
}

/** A tenant store as one object: the real engine behind the D1 adapter; every statement it receives is logged. */
function store(files = TARGET) {
  const storage = createNodeStorage();
  for (const file of CHAIN.slice(0, files)) applyMigrationFile(storage, file, splitMigrationStatements);
  const kv = memoryKv();
  const engine = new TenantStoreEngine(storage, kv, CHAIN, splitMigrationStatements);
  const statements: string[] = [];
  const calls: string[] = [];
  const stub: TenantStoreStub = {
    query: async (_p, statement, raw) => (calls.push("query"), statements.push(statement.sql), structuredClone(engine.query(structuredClone(statement), raw))),
    batch: async (_p, list) => (calls.push("batch"), statements.push(...list.map((s) => s.sql)), structuredClone(engine.batch(structuredClone(list)))),
    schemaState: async () => (calls.push("schemaState"), engine.schemaState()),
    prepareMigration: async () => (calls.push("prepareMigration"), { bookmark: "bm", state: engine.schemaState() }),
    applyMigrations: async (_p, target, bookmarkId) => (calls.push("applyMigrations"), engine.applyMigrations(target, bookmarkId)),
  };
  const db = createTenantDb({ query: async (_p, s, raw) => structuredClone(engine.query(structuredClone(s), raw)), batch: async (_p, l) => structuredClone(engine.batch(structuredClone(l))) });
  const dump = () => JSON.stringify(storage.db.prepare("SELECT * FROM admin_credentials ORDER BY id").all());
  return { storage, kv, engine, stub, db, statements, calls, dump };
}
type Store = ReturnType<typeof store>;

/** The install claim's effect on the seeded row (src/lib/install.ts), plus one staff user. */
async function claim(s: Store, username = OWNER, email: string | null = OWNER, password = "owner-pass-one-1") {
  s.storage.db.prepare("UPDATE admin_credentials SET username = ?, email = ?, password_hash = ?, must_change_password = 0, updated_at = '2026-11-20T00:00:00.000Z' WHERE id = 1")
    .run(username, email, await hashAdminPassword(password));
  s.storage.db.prepare("INSERT INTO admin_credentials (id, username, email, password_hash, must_change_password, updated_at, role) VALUES (2, 'kasir', 'kasir@toko-a.test', ?, 0, '2026-11-20T00:00:00.000Z', 'admin')")
    .run(await hashAdminPassword("staff-pass-two-2"));
}

async function platform(status: string, ...ids: string[]): Promise<SqliteD1> {
  const db = createSqliteD1();
  await ensureControlPlane(db, PLATFORM_CHAIN);
  for (const id of ids.length ? ids : ["t-a"]) {
    db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES (?, ?, ?, ?, '2026-11-20')").run(id, id, id === "t-a" ? OWNER : `owner@${id}.test`, status);
    db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'active', 1, '2026-11-20')").run(`${id}.adsbook.my.id`, id);
  }
  db.queries.length = 0;
  return db;
}

const controlPlane = (db: SqliteD1) => JSON.stringify(["tenants", "tenant_events", "platform_identities", "handoff_tokens", "migration_bookmarks"].map((t) => db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

test("checkRestoredOwnerIdentity: a fenced tenant with one bound owner passes, with verified always false", async () => {
  const db = await platform("recovery");
  const s = store();
  await claim(s);
  assert.deepEqual(await checkRestoredOwnerIdentity(db, s.stub, "t-a", TARGET), { ok: true, credentialId: 1, boundBy: "both", verified: false });
});

test("checkRestoredOwnerIdentity: only a fenced tenant is checked", async () => {
  for (const status of ["active", "suspended", "purging", "purged", "provisioning"]) {
    const db = await platform(status);
    const s = store();
    await claim(s);
    assert.deepEqual(await checkRestoredOwnerIdentity(db, s.stub, "t-a", TARGET), { ok: false, reason: "not_fenced" }, status);
    assert.deepEqual(s.calls, [], `${status}: the store is never asked`);
  }
  const db = await platform("recovery");
  assert.deepEqual(await checkRestoredOwnerIdentity(db, store().stub, "t-missing", TARGET), { ok: false, reason: "not_fenced" });
});

test("checkRestoredOwnerIdentity: a store behind the target or in its own recovery is refused and never migrated", async () => {
  const db = await platform("recovery");
  const behind = store(TARGET - 1);
  await claim(behind);
  assert.deepEqual(await checkRestoredOwnerIdentity(db, behind.stub, "t-a", TARGET), { ok: false, reason: "schema_not_at_target" });
  assert.deepEqual(behind.calls, ["schemaState"], "no prepareMigration, no applyMigrations, no read");
  assert.equal(behind.engine.schemaState().applied, TARGET - 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM migration_bookmarks").get()!.n, 0);

  const guarded = store();
  await claim(guarded);
  guarded.engine.setRecovery(true);
  assert.deepEqual(await checkRestoredOwnerIdentity(db, guarded.stub, "t-a", TARGET), { ok: false, reason: "schema_not_at_target" });
});

test("checkRestoredOwnerIdentity: a store that does not answer is refused, not guessed", async () => {
  const db = await platform("recovery");
  const s = store();
  await claim(s);
  const silent: TenantStoreStub = { ...s.stub, schemaState: async () => { throw new Error("object gone"); } };
  assert.deepEqual(await checkRestoredOwnerIdentity(db, silent, "t-a", TARGET), { ok: false, reason: "store_unreachable" });
  const unreadable: TenantStoreStub = { ...s.stub, query: async () => { throw new Error("reset"); } };
  assert.deepEqual(await checkRestoredOwnerIdentity(db, unreadable, "t-a", TARGET), { ok: false, reason: "store_unreachable" });
});

test("checkRestoredOwnerIdentity: refusals over real restored data, and nothing is written on either side", async () => {
  const cases: Array<[string, (s: Store) => Promise<void>, string]> = [
    ["restore before the claim (seeded default owner)", async () => undefined, "owner_unclaimed"],
    ["renamed owner without email", (s) => claim(s, "renamed-owner", null), "owner_unbound"],
    ["owner row demoted", async (s) => { await claim(s); s.storage.db.prepare("UPDATE admin_credentials SET role = 'admin' WHERE id = 1").run(); }, "no_owner"],
    ["second owner row", async (s) => { await claim(s); s.storage.db.prepare("UPDATE admin_credentials SET role = 'owner' WHERE id = 2").run(); }, "multiple_owners"],
    ["staff carries the owner address", async (s) => { await claim(s, "renamed-owner", OWNER); s.storage.db.prepare("UPDATE admin_credentials SET username = ? WHERE id = 2").run(OWNER); }, "owner_email_shadowed"],
  ];
  for (const [name, setup, reason] of cases) {
    const db = await platform("recovery", "t-a", "t-b");
    const s = store();
    await setup(s);
    const before = { control: controlPlane(db), tenant: s.dump() };
    assert.deepEqual(await checkRestoredOwnerIdentity(db, s.stub, "t-a", TARGET), { ok: false, reason }, name);
    assert.ok(db.queries.every((sql) => /^\s*SELECT\b/i.test(sql)), `${name}: control plane read-only ${JSON.stringify(db.queries)}`);
    assert.ok(s.statements.every((sql) => /^\s*SELECT\b/i.test(sql)), `${name}: tenant store read-only`);
    assert.deepEqual({ control: controlPlane(db), tenant: s.dump() }, before, `${name}: unchanged`);
    const b = db.sqlite.prepare("SELECT status FROM tenants WHERE id = 't-b'").get() as { status: string };
    assert.equal(b.status, "recovery", `${name}: tenant B untouched`);
  }
});

test("agreement with IAM-9: a pass names the row the real owner recovery changes; an unbound or missing owner is IAM-9's owner_missing", async () => {
  const outcomes: Array<[string, (s: Store) => Promise<void>]> = [
    ["bound by both", (s) => claim(s)],
    ["bound by email after a rename", (s) => claim(s, "renamed-owner", OWNER)],
    ["renamed without email", (s) => claim(s, "renamed-owner", null)],
    ["case differs", (s) => claim(s, "Owner@Toko-A.test", "Owner@Toko-A.test")],
    ["no owner", async (s) => { await claim(s); s.storage.db.prepare("UPDATE admin_credentials SET role = 'admin' WHERE id = 1").run(); }],
  ];
  for (const [name, setup] of outcomes) {
    const db = await platform("recovery");
    const s = store();
    await setup(s);
    const verdict = await checkRestoredOwnerIdentity(db, s.stub, "t-a", TARGET);
    // The emulated reopen (a later operator act, not this module), then a fresh IAM-9 token.
    db.sqlite.prepare("UPDATE tenants SET status = 'active' WHERE id = 't-a'").run();
    const token = await prepareHandoff(db, "t-a", "t-a.adsbook.my.id", "owner_recovery");
    await token.statement.run();
    const before = s.storage.db.prepare("SELECT id, updated_at FROM admin_credentials ORDER BY id").all() as Array<{ id: number; updated_at: string }>;
    const redeemed = await redeemOwnerRecovery(db, s.db, { tenantId: "t-a", host: "t-a.adsbook.my.id", hostKind: "subdomain" }, token.token, "owner-pass-new-9");
    const after = s.storage.db.prepare("SELECT id, updated_at FROM admin_credentials ORDER BY id").all() as Array<{ id: number; updated_at: string }>;
    const changed = after.filter((r, i) => r.updated_at !== before[i].updated_at).map((r) => Number(r.id));
    if (verdict.ok) {
      assert.deepEqual(redeemed, { ok: true }, `${name}: IAM-9 succeeds`);
      assert.deepEqual(changed, [verdict.credentialId], `${name}: exactly the predicted row`);
      const owner = await s.db.prepare("SELECT username FROM admin_credentials WHERE id = ?").bind(verdict.credentialId).first<{ username: string }>();
      assert.equal(await verifyAdminLoginPassword("owner-pass-new-9", (await getAdminCredential(s.db, owner!.username))!), true);
    } else {
      assert.deepEqual(redeemed, { ok: false, status: 500, error: "Pemulihan gagal. Minta kode pemulihan baru ke tim adsbook.id." }, `${name}: IAM-9 fails too`);
      assert.deepEqual(changed, [], `${name}: nothing changed`);
    }
  }
});

test("stricter than IAM-9 on purpose: with two bound owners IAM-9 would pick the lowest id; the check refuses", async () => {
  const db = await platform("recovery");
  const s = store();
  await claim(s);
  s.storage.db.prepare("UPDATE admin_credentials SET role = 'owner', email = ? WHERE id = 2").run(OWNER);
  assert.deepEqual(await checkRestoredOwnerIdentity(db, s.stub, "t-a", TARGET), { ok: false, reason: "multiple_owners" });
});

test("source scan: IAM-9 still looks the owner up with the exact predicate this check mirrors", () => {
  const recovery = readFileSync(new URL("./admin/recovery.ts", import.meta.url), "utf8");
  assert.ok(recovery.includes("SELECT id FROM admin_credentials WHERE role = 'owner' AND (username = ?3 OR email = ?3) ORDER BY id LIMIT 1"), "IAM-9's owner lookup changed: update resolveBoundOwner with it");
  const module = readFileSync(new URL("./owner-identity.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/openTenantDb|ensureTenantSchema|syncTenantIdentities|INSERT|UPDATE|DELETE/.test(module), "read-only: no schema step, no sync, no write");
  const phaseB = module.indexOf("export async function checkPostSyncOwnerIdentity");
  assert.ok(phaseB > 0);
  assert.ok(!module.slice(0, phaseB).includes("platform_identities"), "phase A never reads the registry");
  assert.ok(!/sync|blocked/i.test(module.slice(phaseB).match(/\(([\s\S]*?)\): Promise<PostSyncOwnerVerdict>/)![1]), "phase B takes no caller-supplied sync result");
});

// ── phase B ("post_sync"): after an approved registry reconciliation ────────
const env = (db: SqliteD1) => ({ PLATFORM_DB: db });
const registryOf = (db: SqliteD1, tenantId: string) =>
  JSON.stringify(db.sqlite.prepare("SELECT identifier, kind, credential_id FROM platform_identities WHERE tenant_id = ? ORDER BY identifier").all(tenantId));
const tenantRow = (db: SqliteD1, tenantId: string) => ({ ...(db.sqlite.prepare("SELECT status, cache_version, owner_email FROM tenants WHERE id = ?").get(tenantId) as object) });
const run = (s: Store, sql: string, ...args: Array<string | number | null>) => s.storage.db.prepare(sql).run(...args);

/**
 * Live history, synced; after the bookmark staff id 2 leaves and the id is
 * reused, a third member joins, the live sync follows; then the restore
 * through the real fence, and phase A. Tenant B stays live throughout.
 */
async function restoredAfterLiveSync() {
  const db = await platform("active", "t-a", "t-b");
  const a = store();
  const b = store();
  await claim(a);
  await claim(b, "owner@t-b.test", "owner@t-b.test");
  run(b, "UPDATE admin_credentials SET username = 'kasir-b', email = NULL WHERE id = 2");
  await syncTenantIdentities(env(db), "t-a", a.db);
  await syncTenantIdentities(env(db), "t-b", b.db);
  const bookmark = a.storage.db.prepare("SELECT * FROM admin_credentials").all().map((r) => ({ ...r }));
  run(a, "DELETE FROM admin_credentials WHERE id = 2");
  run(a, "INSERT INTO admin_credentials (id, username, email, password_hash, must_change_password, updated_at, role) VALUES (2, 'gudang-a', NULL, 'x', 0, '2026-11-20T01:00:00.000Z', 'admin')");
  run(a, "INSERT INTO admin_credentials (id, username, email, password_hash, must_change_password, updated_at, role) VALUES (3, 'iklan-a', 'iklan@toko-a.test', 'x', 0, '2026-11-20T01:00:00.000Z', 'advertiser')");
  await syncTenantIdentities(env(db), "t-a", a.db);
  const restoring: TenantStoreStub = {
    ...a.stub,
    prepareRestore: async () => ({ undo: "undo" }),
    restart: async () => {
      a.storage.db.exec("DELETE FROM admin_credentials");
      for (const row of bookmark) {
        const cols = Object.keys(row);
        a.storage.db.prepare(`INSERT INTO admin_credentials (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => (row as Record<string, never>)[c]));
      }
      throw new Error("Application called abort() to reset Durable Object.");
    },
  };
  await restoreTenant(db, () => restoring, "t-a", "bm", "test:operator");
  const phaseA = await checkRestoredOwnerIdentity(db, a.stub, "t-a", TARGET);
  assert.ok(phaseA.ok, "phase A passes on the restored owner");
  const expected: BoundOwner = { credentialId: phaseA.credentialId, boundBy: phaseA.boundBy };
  const bBefore = { registry: registryOf(db, "t-b"), row: tenantRow(db, "t-b"), store: b.dump() };
  return { db, a, b, expected, bBefore };
}
type Restored = Awaited<ReturnType<typeof restoredAfterLiveSync>>;

/** G3 as planned (hash and revision only; emulated), then the approved reconciliation (G4). */
async function lockAndReconcile(w: Restored) {
  run(w.a, "UPDATE admin_credentials SET password_hash = '!restore-locked', must_change_password = 1, updated_at = '2026-11-20T23:00:00.000Z'");
  return reconcileFencedTenantIdentities(env(w.db), "t-a", w.a.db);
}
const bUnchanged = (w: Restored, name = "") =>
  assert.deepEqual({ registry: registryOf(w.db, "t-b"), row: tenantRow(w.db, "t-b"), store: w.b.dump() }, w.bBefore, `${name} tenant B unchanged`);
const addTenantC = (db: SqliteD1) =>
  db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-c', 't-c', 'owner@t-c.test', 'active', '2026-11-20')").run();

test("post-sync: after the approved reconciliation the registry equals its derivation and names the phase A owner; read-only; A stays fenced; B unchanged", async () => {
  const w = await restoredAfterLiveSync();
  assert.deepEqual((await lockAndReconcile(w)).blocked, []);
  w.db.queries.length = 0;
  w.a.statements.length = 0;
  const before = { registry: registryOf(w.db, "t-a"), store: w.a.dump() };
  assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: true, credentialId: 1, boundBy: "both", verified: false });
  assert.ok(w.db.queries.every((q) => /^\s*SELECT\b/i.test(q)), `control plane read-only ${JSON.stringify(w.db.queries)}`);
  assert.ok(w.a.statements.every((q) => /^\s*SELECT\b/i.test(q)), "store read-only");
  assert.deepEqual({ registry: registryOf(w.db, "t-a"), store: w.a.dump() }, before);
  assert.deepEqual(tenantRow(w.db, "t-a"), { status: "recovery", cache_version: 2, owner_email: OWNER }, "never reopened");
  assert.equal(w.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenant_events WHERE tenant_id = 't-a' AND kind NOT LIKE 'restore_%'").get()!.n, 0, "no event");
  bUnchanged(w);
});

test("post-sync: before the reconciliation the registry the restore left behind is stale", async () => {
  const w = await restoredAfterLiveSync();
  assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason: "registry_stale" });
  bUnchanged(w);
});

test("post-sync: an owner that changed since phase A is refused (binding, recreated id, second owner, unbound)", async () => {
  const cases: Array<[string, (w: Restored) => void, string]> = [
    ["username renamed: binding both → email", (w) => run(w.a, "UPDATE admin_credentials SET username = 'renamed' WHERE id = 1"), "identity_changed"],
    ["owner row recreated under another id", (w) => run(w.a, "UPDATE admin_credentials SET id = 7 WHERE id = 1"), "identity_changed"],
    ["a second owner", (w) => run(w.a, "UPDATE admin_credentials SET role = 'owner' WHERE id = 2"), "multiple_owners"],
    ["owner unbound", (w) => run(w.a, "UPDATE admin_credentials SET username = 'renamed', email = NULL WHERE id = 1"), "owner_unbound"],
  ];
  for (const [name, change, reason] of cases) {
    const w = await restoredAfterLiveSync();
    change(w);
    await lockAndReconcile(w);
    assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason }, name);
    bUnchanged(w, name);
  }
});

test("post-sync (v1 strict): a name another store holds always stops — the owner's or a staff member's — with no name in the result", async () => {
  {
    const w = await restoredAfterLiveSync();
    addTenantC(w.db);
    w.db.sqlite.prepare("UPDATE platform_identities SET tenant_id = 't-c', credential_id = 1 WHERE identifier = ?").run(OWNER);
    const sync = await lockAndReconcile(w);
    assert.ok(sync.blocked.includes(OWNER), "the reconciliation could not take it");
    assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason: "registry_owner_blocked" });
    bUnchanged(w, "owner blocked:");
  }
  {
    const w = await restoredAfterLiveSync();
    addTenantC(w.db);
    w.db.sqlite.prepare("INSERT OR REPLACE INTO platform_identities (identifier, tenant_id, kind, credential_id, created_at) VALUES ('kasir', 't-c', 'staff_username', 5, '2026-11-20')").run();
    assert.deepEqual((await lockAndReconcile(w)).blocked, ["kasir"]);
    const verdict = await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected);
    assert.deepEqual(verdict, { ok: false, reason: "registry_staff_blocked" });
    assert.ok(!JSON.stringify(verdict).includes("kasir"), "triage code carries no name");
    bUnchanged(w, "staff blocked:");
  }
  assert.equal(checkPostSyncOwnerIdentity.length, 5, "no override and no caller-supplied sync result in the signature");
});

test("post-sync: collisions are read from the registry's own rows — one that appears after the reconciliation still stops", async () => {
  const w = await restoredAfterLiveSync();
  assert.deepEqual((await lockAndReconcile(w)).blocked, [], "the approved reconciliation reported nothing");
  addTenantC(w.db);
  w.db.sqlite.prepare("UPDATE platform_identities SET tenant_id = 't-c' WHERE identifier = 'kasir@toko-a.test'").run();
  assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason: "registry_staff_blocked" });
});

test("post-sync: a registry that drifts after the reconciliation is stale (extra row, owner_email on staff, reused id, missing row)", async () => {
  const drifts: Array<[string, (db: SqliteD1) => void]> = [
    ["extra identifier", (db) => db.sqlite.prepare("INSERT INTO platform_identities (identifier, tenant_id, kind, credential_id, created_at) VALUES ('ghost-a', 't-a', 'staff_username', 9, '2026-11-20')").run()],
    ["owner_email points at staff", (db) => db.sqlite.prepare("UPDATE platform_identities SET credential_id = 2 WHERE identifier = ?").run(OWNER)],
    ["staff identifier on a reused id", (db) => db.sqlite.prepare("UPDATE platform_identities SET credential_id = 3 WHERE identifier = 'kasir'").run()],
    ["kind changed", (db) => db.sqlite.prepare("UPDATE platform_identities SET kind = 'staff_email' WHERE identifier = 'kasir'").run()],
    ["identifier missing", (db) => db.sqlite.prepare("DELETE FROM platform_identities WHERE identifier = 'kasir@toko-a.test'").run()],
  ];
  for (const [name, drift] of drifts) {
    const w = await restoredAfterLiveSync();
    await lockAndReconcile(w);
    drift(w.db);
    assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason: "registry_stale" }, name);
    bUnchanged(w, name);
  }
});

test("post-sync: the reconciliation never settles an ambiguous owner — a second owner before it is still refused after it", async () => {
  const w = await restoredAfterLiveSync();
  run(w.a, "UPDATE admin_credentials SET role = 'owner' WHERE id = 2");
  await lockAndReconcile(w); // desiredIdentities maps owner_email to the first owner it meets
  assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason: "multiple_owners" });
});

test("post-sync: the phase A rules still gate it (not fenced, store unreachable)", async () => {
  const w = await restoredAfterLiveSync();
  await lockAndReconcile(w);
  const silent: TenantStoreStub = { ...w.a.stub, schemaState: async () => { throw new Error("object gone"); } };
  assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, silent, "t-a", TARGET, w.expected), { ok: false, reason: "store_unreachable" });
  w.db.sqlite.prepare("UPDATE tenants SET status = 'active' WHERE id = 't-a'").run();
  assert.deepEqual(await checkPostSyncOwnerIdentity(w.db, w.a.stub, "t-a", TARGET, w.expected), { ok: false, reason: "not_fenced" });
});
