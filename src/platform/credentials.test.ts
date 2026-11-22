// T-53 (IAM-11): the platform operator's credential lifecycle against the real
// control-plane chain on SQLite — self change, owner-assisted reset links,
// enrollment links — asserted as security properties: which factor each step
// needs, what is revoked, what a replay or a race gets, and what never leaves
// the server.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import { hashAdminPassword } from "../lib/admin-credentials.ts";
import { verifyPasswordHash } from "../lib/auth.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";
import { changeOwnPassword, consumeCredentialGrant, credentialLinkPolicy, GRANT_TTL_MS, issueCredentialGrant, peekCredentialGrant } from "./admin/credentials.ts";
import { platformGuard } from "./admin/guard.ts";
import { platformLogin, resolvePlatformUser, type PlatformUser } from "./admin/session.ts";
import * as teamModule from "./admin/team.ts";
import { addTeamMember, issueTeamMemberLink, setTeamMemberDisabled, setTeamMemberRole } from "./admin/team.ts";
import { exportPlatformDbSql } from "./backup.ts";
import { newTotpSecret, totpCode } from "./admin/totp.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
// Sign-in applies the bundled chain (a Vite glob in the Worker): give it the files on disk.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./bundled-migrations.ts" && /src\/platform\//.test(context.parentURL ?? "")) return { url: "stub:platform-chain", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "stub:platform-chain") return { format: "module", source: `export const PLATFORM_MIGRATIONS = ${JSON.stringify(CHAIN)};`, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const ORIGIN = "https://app.adsbook.id";
const OPEN = () => credentialLinkPolicy({});
const SECRET = "x".repeat(40);
const OWNER_PASSWORD = "owner-password-123";
const SUPPORT_PASSWORD = "support-password-123";
// Every action takes `now`; each claimed code comes from a later 30-second step than the one before.
const BASE = Date.now();
const at = (offset: number) => new Date(BASE + offset * 30_000);
const code = (secret: string, offset: number) => totpCode(secret, Math.floor(at(offset).getTime() / 30_000));

async function fixture() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  const ownerSecret = newTotpSecret();
  const supportSecret = newTotpSecret();
  const insert = db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("pu_owner", "owner@ops.test", await hashAdminPassword(OWNER_PASSWORD), ownerSecret, "platform_owner", at(-100).toISOString());
  insert.run("pu_support", "cs@ops.test", await hashAdminPassword(SUPPORT_PASSWORD), supportSecret, "platform_support", at(-100).toISOString());
  const session = (userId: string, id: string) =>
    db.sqlite.prepare("INSERT INTO platform_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(id, userId, at(1000).toISOString(), at(-1).toISOString());
  // Each acting operator carries the live session that authorized the request, as resolvePlatformUser returns it.
  session("pu_owner", "auth_owner");
  session("pu_support", "auth_support");
  const owner: PlatformUser = { id: "pu_owner", email: "owner@ops.test", role: "platform_owner", sessionId: "auth_owner" };
  const support: PlatformUser = { id: "pu_support", email: "cs@ops.test", role: "platform_support", sessionId: "auth_support" };
  const open = (id: string) => (db.sqlite.prepare("SELECT revoked_at FROM platform_sessions WHERE id = ?").get(id) as { revoked_at: string | null }).revoked_at === null;
  const user = (id: string) => db.sqlite.prepare("SELECT password_hash, totp_secret, totp_last_step FROM platform_users WHERE id = ?").get(id) as { password_hash: string; totp_secret: string | null; totp_last_step: number | null };
  const events = () => db.sqlite.prepare("SELECT kind, actor, detail_json FROM tenant_events WHERE tenant_id = '_platform' ORDER BY id").all() as { kind: string; actor: string; detail_json: string }[];
  /** Every text value stored anywhere in the control plane except the authenticator secret column. */
  const everything = () => {
    const tables = (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    return tables.map((name) => JSON.stringify(db.sqlite.prepare(`SELECT * FROM "${name}"`).all().map((row) => ({ ...(row as object), totp_secret: undefined })))).join("\n");
  };
  return { db, owner, support, ownerSecret, supportSecret, session, open, user, events, everything };
}

const tokenOf = (link: string) => link.split("#")[1];

test("IAM-11 self change: current password + a fresh unused code; TOTP kept; every session and open link revoked; audited without secrets", async () => {
  const { db, support, supportSecret, owner, ownerSecret, session, open, user, events, everything } = await fixture();
  session("pu_support", "sa");
  session("pu_support", "sb");
  session("pu_owner", "so");
  const before = user("pu_support");

  const wrongPassword = await changeOwnPassword(db, support, { current: "nope-nope-nope", totp: await code(supportSecret, 0), password: "brand-new-password-1" }, at(0));
  assert.equal(wrongPassword.ok || wrongPassword.status, 401);
  assert.equal(user("pu_support").totp_last_step, null, "a wrong password does not burn the code");
  const wrongCode = await changeOwnPassword(db, support, { current: SUPPORT_PASSWORD, totp: "000000", password: "brand-new-password-1" }, at(0));
  assert.equal(wrongCode.ok || wrongCode.status, 401);
  assert.equal((await changeOwnPassword(db, support, { current: SUPPORT_PASSWORD, totp: await code(supportSecret, 0), password: SUPPORT_PASSWORD }, at(0))).ok, false, "a new password, not the same one");
  assert.equal((await changeOwnPassword(db, support, { current: SUPPORT_PASSWORD, totp: await code(supportSecret, 0), password: "CS@ops.test" }, at(0))).ok, false, "not the email");
  assert.equal((await changeOwnPassword(db, support, { current: SUPPORT_PASSWORD, totp: await code(supportSecret, 0), password: "short" }, at(0))).ok, false, "12+ characters");

  // An open reset link for this operator, issued earlier by the owner.
  const link = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.ok(link.ok);
  session("pu_support", "sc"); // signed in again after the issuance closed the others

  const changed = await changeOwnPassword(db, { ...support, sessionId: "sc" }, { current: SUPPORT_PASSWORD, totp: await code(supportSecret, 1), password: "brand-new-password-1" }, at(1));
  assert.ok(changed.ok, JSON.stringify(changed));
  const after = user("pu_support");
  assert.ok(await verifyPasswordHash("brand-new-password-1", after.password_hash));
  assert.equal(after.totp_secret, before.totp_secret, "enrollment kept: the same authenticator signs in");
  assert.equal(open("sc"), false, "the initiating session too");
  assert.equal(open("so"), true, "another operator's session is untouched");
  assert.equal((await peekCredentialGrant(db, tokenOf(link.value!.link), "198.51.100.1", OPEN, at(1))).ok, false, "an open link dies with the change");

  session("pu_support", "sd");
  const replay = await changeOwnPassword(db, { ...support, sessionId: "sd" }, { current: "brand-new-password-1", totp: await code(supportSecret, 1), password: "another-password-12" }, at(1));
  assert.equal(replay.ok || replay.status, 401, "the code of the change is spent");

  const audit = events().filter((event) => event.kind === "platform_password_changed");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "platform:pu_support");
  assert.ok(!everything().includes("brand-new-password-1"), "no plaintext password anywhere");
});

test("IAM-11 self change closes a live session at once: the cookie stops resolving on the next request", async () => {
  const { db, supportSecret } = await fixture();
  const env = { PLATFORM_DB: db, PLATFORM_AUTH_SECRET: SECRET };
  const login = await platformLogin(env, { email: "cs@ops.test", password: SUPPORT_PASSWORD, totp: await totpCode(supportSecret, Math.floor(Date.now() / 30_000)) }, "203.0.113.9");
  assert.ok(login.ok);
  if (!login.ok) return;
  const request = new Request(`${ORIGIN}/platform`, { headers: { cookie: `__Host-adsbook_platform=${login.cookie}` } });
  const resolved = await resolvePlatformUser(env, request);
  assert.equal(resolved?.id, "pu_support");
  assert.ok(resolved?.sessionId, "the resolved user carries the authorizing session");
  const changed = await changeOwnPassword(db, resolved!, { current: SUPPORT_PASSWORD, totp: await code(supportSecret, 2), password: "brand-new-password-1" }, at(2));
  assert.ok(changed.ok);
  assert.equal(await resolvePlatformUser(env, request), null);
});

test("IAM-11 reset link: owner-only behind a fresh step-up code; never self, never an owner (break-glass); issuance revokes sessions and older links; only a digest is stored", async () => {
  const { db, owner, ownerSecret, support, supportSecret, session, open, everything, events } = await fixture();
  session("pu_support", "s1");
  assert.equal((await issueCredentialGrant(db, support, "pu_owner", "password_reset", await code(supportSecret, 0), ORIGIN, OPEN, at(0))).ok, false, "support cannot");
  assert.equal((await issueCredentialGrant(db, owner, "pu_owner", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0))).ok, false, "never yourself");
  db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_o2', 'o2@ops.test', 'x', 'AAAA', 'platform_owner', ?)").run(at(-1).toISOString());
  const ownerTarget = await issueCredentialGrant(db, owner, "pu_o2", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.match(ownerTarget.ok ? "" : ownerTarget.error, /break-glass/, "an owner's password is never reset from the console");
  const noCode = await issueCredentialGrant(db, owner, "pu_support", "password_reset", "123456", ORIGIN, OPEN, at(0));
  assert.equal(noCode.ok || noCode.status, 401, "step-up required");
  assert.equal(open("s1"), true, "a refused issuance touches nothing");

  const first = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.ok(first.ok && first.value);
  assert.equal(open("s1"), false, "the target's sessions close at issuance");
  assert.equal(first.value.expiresAt, new Date(at(0).getTime() + GRANT_TTL_MS.password_reset).toISOString(), "30 minutes");
  const replayStepUp = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.equal(replayStepUp.ok || replayStepUp.status, 401, "a step-up code works once");
  const second = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 1), ORIGIN, OPEN, at(1));
  assert.ok(second.ok && second.value);
  assert.equal((await peekCredentialGrant(db, tokenOf(first.value.link), "198.51.100.1", OPEN, at(1))).ok, false, "a newer link revokes the older one");
  assert.ok((await peekCredentialGrant(db, tokenOf(second.value.link), "198.51.100.1", OPEN, at(1))).ok);
  const stored = everything();
  assert.ok(!stored.includes(tokenOf(first.value.link)) && !stored.includes(tokenOf(second.value.link)), "the token is never stored, only its digest");
  assert.ok(events().every((event) => !event.detail_json.includes(tokenOf(second.value!.link))));
});

test("IAM-11 reset redemption: the link plus the enrolled authenticator; a typo does not spend it; single use under a race; expired and cross-user links do nothing", async () => {
  const { db, owner, ownerSecret, supportSecret, user, events, everything, session } = await fixture();
  const issued = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.ok(issued.ok && issued.value);
  const token = tokenOf(issued.value.link);
  const ownerBefore = user("pu_owner");
  const totpBefore = user("pu_support").totp_secret;

  const peek = await peekCredentialGrant(db, token, "198.51.100.1", OPEN, at(0));
  assert.deepEqual(peek.ok && peek.value, { purpose: "password_reset", email: "cs@ops.test" }, "a reset shows no secret");
  assert.equal((await consumeCredentialGrant(db, token, { password: "short", totp: await code(supportSecret, 1) }, "198.51.100.1", OPEN, at(1))).ok, false);
  const wrongCode = await consumeCredentialGrant(db, token, { password: "reset-password-123", totp: await code(ownerSecret, 1) }, "198.51.100.1", OPEN, at(1));
  assert.equal(wrongCode.ok || wrongCode.status, 401, "the link alone, or another operator's code, is not enough");
  assert.ok((await peekCredentialGrant(db, token, "198.51.100.1", OPEN, at(1))).ok, "still usable after typos");

  // Two redemptions at once, each with a valid code of its own step: exactly one wins.
  const [left, right] = await Promise.all([
    consumeCredentialGrant(db, token, { password: "reset-password-left", totp: await code(supportSecret, 1) }, "198.51.100.1", OPEN, at(1)),
    consumeCredentialGrant(db, token, { password: "reset-password-right", totp: await code(supportSecret, 2) }, "198.51.100.2", OPEN, at(2)),
  ]);
  assert.equal([left, right].filter((result) => result.ok).length, 1, JSON.stringify([left, right]));
  const winner = left.ok ? "reset-password-left" : "reset-password-right";
  const after = user("pu_support");
  assert.ok(await verifyPasswordHash(winner, after.password_hash));
  assert.equal(after.totp_secret, totpBefore, "the authenticator is kept");
  assert.deepEqual(user("pu_owner"), ownerBefore, "nobody else changes");
  const winningStep = left.ok ? 1 : 2;
  // A live session of its own, so the refusal can only be the replayed code (Sol T-53 review).
  session("pu_support", "after_reset");
  const reuse = await changeOwnPassword(db, { id: "pu_support", email: "cs@ops.test", role: "platform_support", sessionId: "after_reset" }, { current: winner, totp: await code(supportSecret, winningStep), password: "reuse-password-123" }, at(winningStep));
  assert.deepEqual(reuse, { ok: false, status: 401, error: "Kode ini sudah dipakai. Tunggu kode berikutnya." }, "the code that proved the reset is spent, like a sign-in code");
  const fresh = await changeOwnPassword(db, { id: "pu_support", email: "cs@ops.test", role: "platform_support", sessionId: "after_reset" }, { current: winner, totp: await code(supportSecret, winningStep + 10), password: "reuse-password-123" }, at(winningStep + 10));
  assert.ok(fresh.ok, `the same request with a fresh code succeeds: ${JSON.stringify(fresh)}`);
  const again = await consumeCredentialGrant(db, token, { password: "reset-password-again", totp: await code(supportSecret, 3) }, "198.51.100.1", OPEN, at(3));
  assert.equal(again.ok || again.status, 410, "used is used");
  assert.equal(events().filter((event) => event.kind === "platform_access_link_used").length, 1);
  assert.ok(!everything().includes(winner) && !everything().includes(token));

  const late = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 4), ORIGIN, OPEN, at(4));
  assert.ok(late.ok && late.value);
  const expired = new Date(at(4).getTime() + GRANT_TTL_MS.password_reset + 1);
  assert.equal((await peekCredentialGrant(db, tokenOf(late.value.link), "198.51.100.1", OPEN, expired)).ok, false, "expired");
  assert.equal((await consumeCredentialGrant(db, tokenOf(late.value.link), { password: "reset-password-late", totp: await totpCode(supportSecret, Math.floor(expired.getTime() / 30_000)) }, "198.51.100.1", OPEN, expired)).ok, false);
  assert.equal((await consumeCredentialGrant(db, "f".repeat(64), { password: "reset-password-late", totp: "123456" }, "198.51.100.1", OPEN, at(5))).ok, false, "an unknown token");
});

test("IAM-11 enrollment: a new member proves a code from the new authenticator before activation; the code then cannot sign in again; disable kills the link", async () => {
  const { db, owner, ownerSecret, user } = await fixture();
  const added = await addTeamMember(db, owner, { email: "new@ops.test", role: "platform_support", totp: await code(ownerSecret, 0) }, ORIGIN, OPEN, at(0));
  assert.ok(added.ok && added.value);
  if (!added.ok || !added.value) return;
  const token = tokenOf(added.value.link);
  const env = { PLATFORM_DB: db, PLATFORM_AUTH_SECRET: SECRET };
  assert.equal((await platformLogin(env, { email: "new@ops.test", password: "", totp: "000000" }, "203.0.113.1")).ok, false, "not enrolled, cannot sign in");

  const peek = await peekCredentialGrant(db, token, "198.51.100.1", OPEN, at(0));
  assert.ok(peek.ok && peek.value?.purpose === "enrollment" && peek.value.totpSecret);
  const secret = peek.value!.totpSecret!;
  assert.equal(user(added.value.id).totp_secret, null, "the offered secret is not stored by a peek");
  const other = newTotpSecret();
  assert.equal((await consumeCredentialGrant(db, token, { password: "member-password-1", totp: await code(other, 1), totpSecret: secret }, "198.51.100.1", OPEN, at(1))).ok, false, "a code from another authenticator");
  assert.equal((await consumeCredentialGrant(db, token, { password: "member-password-1", totp: await code(secret, 1), totpSecret: "not-base32" }, "198.51.100.1", OPEN, at(1))).ok, false);

  const [left, right] = await Promise.all([
    consumeCredentialGrant(db, token, { password: "member-password-1", totp: await code(secret, 1), totpSecret: secret }, "198.51.100.1", OPEN, at(1)),
    consumeCredentialGrant(db, token, { password: "member-password-2", totp: await code(other, 1), totpSecret: other }, "198.51.100.2", OPEN, at(1)),
  ]);
  assert.equal([left, right].filter((result) => result.ok).length, 1, "one enrollment per link");
  const enrolled = user(added.value.id);
  const won = left.ok ? secret : other;
  assert.equal(enrolled.totp_secret, won);
  assert.equal(enrolled.totp_last_step, Math.floor(at(1).getTime() / 30_000), "the proving code is spent");
  assert.ok(await verifyPasswordHash(left.ok ? "member-password-1" : "member-password-2", enrolled.password_hash));
  assert.equal((await peekCredentialGrant(db, token, "198.51.100.1", OPEN, at(2))).ok, false);

  // An enrollment link for someone who is enrolled is no reset of both factors.
  assert.equal((await issueCredentialGrant(db, owner, added.value.id, "enrollment", await code(ownerSecret, 3), ORIGIN, OPEN, at(3))).ok, false);
  // A second pending member: disabling them kills the link before use.
  const pending = await addTeamMember(db, owner, { email: "later@ops.test", role: "platform_support", totp: await code(ownerSecret, 4) }, ORIGIN, OPEN, at(4));
  assert.ok(pending.ok && pending.value);
  assert.ok((await setTeamMemberDisabled(db, owner, pending.value!.id, true, at(4))).ok);
  assert.equal((await peekCredentialGrant(db, tokenOf(pending.value!.link), "198.51.100.1", OPEN, at(4))).ok, false);
});

test("IAM-11 boundaries: the redeem API is public but same-origin only; account change needs a platform session, and a seller session is not one", async () => {
  const { db } = await fixture();
  const env = { PLATFORM_DB: db, PLATFORM_AUTH_SECRET: SECRET };
  const post = (path: string, headers: Record<string, string>) => {
    const url = new URL(path, ORIGIN);
    return platformGuard(new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }), url, env);
  };
  const crossSite = await post("/api/platform/akses", { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.kind === "deny" && crossSite.response.status, 403, "CSRF: no cross-site redemption");
  const sameOrigin = await post("/api/platform/akses", { origin: ORIGIN, "sec-fetch-site": "same-origin" });
  assert.equal(sameOrigin.kind, "pass", "no session needed to redeem");
  const seller = await post("/api/platform/account/password", { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: "__Host-adsbook_session=forged.value" });
  assert.equal(seller.kind === "deny" && seller.response.status, 401, "a seller session is not a platform session");
});

test("IAM-11 no plaintext credential reaches a log", async () => {
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  // Structured arguments are serialised, so a secret nested in a logged object is seen too (Sol T-53 review).
  const render = (value: unknown) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, (_key, inner) => (inner instanceof Error ? { name: inner.name, message: inner.message, stack: inner.stack } : inner));
    } catch {
      return String(value);
    }
  };
  for (const method of ["log", "info", "warn", "error"] as const) console[method] = (...args: unknown[]) => void lines.push(args.map(render).join(" "));
  try {
    const { db, owner, ownerSecret, supportSecret, session } = await fixture();
    const issued = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 0), ORIGIN, OPEN, at(0));
    assert.ok(issued.ok, "issued");
    const used = await consumeCredentialGrant(db, tokenOf(issued.value!.link), { password: "logged-password-1", totp: await code(supportSecret, 1) }, "198.51.100.1", OPEN, at(1));
    assert.ok(used.ok, `redeemed: ${JSON.stringify(used)}`);
    session("pu_support", "after_log_reset");
    const changed = await changeOwnPassword(db, { id: "pu_support", email: "cs@ops.test", role: "platform_support", sessionId: "after_log_reset" }, { current: "logged-password-1", totp: await code(supportSecret, 2), password: "logged-password-2" }, at(2));
    assert.ok(changed.ok, `changed: ${JSON.stringify(changed)}`);
    // The request-log line of the redemption route, as the middleware writes it.
    const { buildRequestLog, writeRequestLog } = await import("./request-log.ts");
    writeRequestLog(buildRequestLog({ request_id: "r", host_kind: "platform", tenant_id: null, route: "/api/platform/akses", method: "POST", status: 200, duration_ms: 1 }));
    const all = lines.join("\n");
    assert.ok(all.includes("/api/platform/akses"), "the scan reads the captured output, so it is not vacuous");
    for (const secret of ["logged-password-1", "logged-password-2", issued.ok ? tokenOf(issued.value!.link) : "-", supportSecret, ownerSecret]) assert.ok(!all.includes(secret));
  } finally {
    Object.assign(console, original);
  }
});

test("IAM-11 migration 0012: an upgrade from v12 keeps users, sessions and audit, and enables grants; a Worker built on the v12 chain then refuses the database (fail closed)", async () => {
  const { ensureSchemaUpgraded } = await import("../lib/schema-version.ts");
  const before = CHAIN.slice(0, 12);
  assert.equal(before.at(-1)?.name, "0011_signup_email_challenges.sql");
  const db = createSqliteD1();
  await ensureSchemaUpgraded(db, { migrations: before, expected: before.length, cache: false });
  const secret = newTotpSecret();
  db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_owner', 'owner@ops.test', ?, ?, 'platform_owner', '2026-11-01'), ('pu_cs', 'cs@ops.test', ?, ?, 'platform_support', '2026-11-01')")
    .run(await hashAdminPassword(OWNER_PASSWORD), secret, await hashAdminPassword(SUPPORT_PASSWORD), newTotpSecret());
  db.sqlite.exec(`
    INSERT INTO platform_sessions (id, user_id, expires_at, created_at) VALUES ('s_live', 'pu_cs', '2099-01-01', '2026-11-19'), ('s_owner', 'pu_owner', '2099-01-01', '2026-11-19');
    INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES ('_platform', 'platform_user_reset', 'platform:pu_owner', '2026-11-10', '{"user":"pu_cs"}');
  `);
  const snapshot = () =>
    ["platform_users", "platform_sessions", "tenant_events"].map((table) =>
      JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((row) => ({ ...(row as object), credential_generation: undefined }))));
  const kept = snapshot();

  await ensureSchemaUpgraded(db, { migrations: CHAIN, expected: CHAIN.length, cache: false });
  assert.deepEqual(snapshot(), kept, "users, sessions and the audit history are untouched");
  assert.deepEqual(db.sqlite.prepare("SELECT DISTINCT credential_generation FROM platform_users").all().map((row) => ({ ...(row as object) })), [{ credential_generation: 0 }], "existing operators start at generation 0");
  const owner: PlatformUser = { id: "pu_owner", email: "owner@ops.test", role: "platform_owner", sessionId: "s_owner" };
  const issued = await issueCredentialGrant(db, owner, "pu_cs", "password_reset", await code(secret, 0), ORIGIN, OPEN, at(0));
  assert.ok(issued.ok, "grants work on the upgraded database");

  // Mixed versions: an older Worker (v12 chain) against this database refuses every control-plane path rather than guess.
  await assert.rejects(ensureSchemaUpgraded(db, { migrations: before, expected: before.length, cache: false }), /SCHEMA_UPGRADE_DATABASE_AHEAD/);
});

/**
 * A handle on the same database that runs `event` once, just before the
 * statement matching `pattern` executes — a credential event committing in
 * the window between a check and its write, deterministically.
 */
function interleave(db: ReturnType<typeof createSqliteD1>, pattern: RegExp, event: () => Promise<void>): D1Database {
  let fired = false;
  const fire = async (sql: string) => {
    if (fired || !pattern.test(sql)) return;
    fired = true;
    await event();
  };
  return {
    ...db,
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const wrap = (bound: ReturnType<typeof db.prepare>): ReturnType<typeof db.prepare> => ({
        ...bound,
        bind: (...args: unknown[]) => wrap(bound.bind(...args)),
        run: async () => (await fire(sql), bound.run()),
        first: async (...args: unknown[]) => (await fire(sql), bound.first(...(args as []))),
        all: async () => (await fire(sql), bound.all()),
      }) as ReturnType<typeof db.prepare>;
      return wrap(statement);
    },
    batch: async (statements: { sql: string }[]) => {
      for (const statement of statements) await fire(statement.sql);
      return db.batch(statements as never);
    },
  } as unknown as D1Database;
}

test("IAM-11 invariant: a sign-in issues its session only while the credential generation it verified still holds", async () => {
  const cases: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    "own password change": async ({ db, support, supportSecret }) => {
      assert.ok((await changeOwnPassword(db, support, { current: SUPPORT_PASSWORD, totp: await code(supportSecret, 3), password: "changed-mid-sign-in" }, at(3))).ok);
    },
    "reset link issued": async ({ db, owner, ownerSecret }) => {
      assert.ok((await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 3), ORIGIN, OPEN, at(3))).ok);
    },
    "disabled": async ({ db, owner }) => {
      assert.ok((await setTeamMemberDisabled(db, owner, "pu_support", true, at(3))).ok);
    },
    // Re-enabled before the sign-in writes: still no session — the disable revoked access, and enabling does not resurrect a sign-in begun before it.
    "disabled and re-enabled": async ({ db, owner }) => {
      assert.ok((await setTeamMemberDisabled(db, owner, "pu_support", true, at(3))).ok);
      assert.ok((await setTeamMemberDisabled(db, owner, "pu_support", false, at(3))).ok);
    },
  };
  for (const [name, event] of Object.entries(cases)) {
    const f = await fixture();
    const racing = interleave(f.db, /INSERT INTO platform_sessions/, () => event(f));
    const env = { PLATFORM_DB: racing, PLATFORM_AUTH_SECRET: SECRET };
    const login = await platformLogin(env, { email: "cs@ops.test", password: SUPPORT_PASSWORD, totp: await totpCode(f.supportSecret, Math.floor(Date.now() / 30_000)) }, "203.0.113.7");
    assert.equal(login.ok, false, `${name}: no session from credentials that were superseded mid-sign-in`);
    const live = f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_sessions WHERE user_id = 'pu_support' AND revoked_at IS NULL").get() as { n: number };
    assert.equal(live.n, 0, `${name}: nothing outlives the revocation`);
  }
  // Without an event in between, the same sign-in works (the fence is not a blanket refusal).
  const f = await fixture();
  const env = { PLATFORM_DB: f.db, PLATFORM_AUTH_SECRET: SECRET };
  assert.ok((await platformLogin(env, { email: "cs@ops.test", password: SUPPORT_PASSWORD, totp: await totpCode(f.supportSecret, Math.floor(Date.now() / 30_000)) }, "203.0.113.7")).ok);
});

test("IAM-11 invariant: credential writes check the acting owner at the write — a demoted or disabled owner adds no member, leaves no pending row, issues no link", async () => {
  // Demoted after their session was resolved: the session object still says owner.
  {
    const { db, owner, ownerSecret, session, open, events } = await fixture();
    session("pu_support", "s_cs");
    db.sqlite.exec("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_o2', 'o2@ops.test', 'x', 'AAAA', 'platform_owner', '2026-11-01')");
    db.sqlite.exec("UPDATE platform_users SET role = 'platform_support' WHERE id = 'pu_owner'");
    const added = await addTeamMember(db, owner, { email: "late@ops.test", role: "platform_support", totp: await code(ownerSecret, 0) }, ORIGIN, OPEN, at(0));
    assert.equal(added.ok || added.status, 403);
    const link = await issueCredentialGrant(db, owner, "pu_support", "password_reset", await code(ownerSecret, 1), ORIGIN, OPEN, at(1));
    assert.equal(link.ok || link.status, 409);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'late@ops.test'").get()!.n, 0, "no pending row");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0, "no grant");
    assert.equal(open("s_cs"), true, "the target's sessions are untouched");
    assert.deepEqual(events(), [], "nothing audited");
  }
  // Disabled in the window between step-up and the write.
  {
    const { db, owner, ownerSecret, events } = await fixture();
    db.sqlite.exec("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_o2', 'o2@ops.test', 'x', 'AAAA', 'platform_owner', '2026-11-01')");
    const racing = interleave(db, /INSERT INTO platform_users/, async () => void db.sqlite.exec("UPDATE platform_users SET disabled_at = '2026-11-19' WHERE id = 'pu_owner'"));
    const added = await addTeamMember(racing, owner, { email: "late@ops.test", role: "platform_support", totp: await code(ownerSecret, 0) }, ORIGIN, OPEN, at(0));
    assert.equal(added.ok, false);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE totp_secret IS NULL").get()!.n, 0, "no pending row without a grant");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0);
    assert.deepEqual(events(), []);
  }
  // A write that fails part-way (the grant insert throws) rolls the member row back with it.
  {
    const { db, owner, ownerSecret, events } = await fixture();
    db.failWhen = /INSERT INTO platform_credential_grants/;
    const added = await addTeamMember(db, owner, { email: "boom@ops.test", role: "platform_support", totp: await code(ownerSecret, 0) }, ORIGIN, OPEN, at(0));
    db.failWhen = null;
    assert.equal(added.ok || added.status, 503, "a failed write is not reported as a duplicate email");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'boom@ops.test'").get()!.n, 0, "no pending row without a grant");
    assert.deepEqual(events(), []);
  }
  // Every pending member has a grant: the add is all or nothing.
  {
    const { db, owner, ownerSecret } = await fixture();
    assert.ok((await addTeamMember(db, owner, { email: "ok@ops.test", role: "platform_support", totp: await code(ownerSecret, 0) }, ORIGIN, OPEN, at(0))).ok);
    const orphans = db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users u WHERE u.totp_secret IS NULL AND NOT EXISTS (SELECT 1 FROM platform_credential_grants g WHERE g.user_id = u.id)").get() as { n: number };
    assert.equal(orphans.n, 0);
  }
});

test("IAM-11 invariant: a credential write commits only while the session that authorized it is live — a disable and re-enable in between voids it", async () => {
  // A second, enrolled owner performs the disable + re-enable that revokes the actor's sessions.
  const withSecondOwner = async () => {
    const f = await fixture();
    f.db.sqlite.exec("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_o2', 'o2@ops.test', 'x', 'AAAA', 'platform_owner', '2026-11-01')");
    f.session("pu_o2", "auth_o2");
    const o2: PlatformUser = { id: "pu_o2", email: "o2@ops.test", role: "platform_owner", sessionId: "auth_o2" };
    const bounce = (userId: string) => async () => {
      assert.ok((await setTeamMemberDisabled(f.db, o2, userId, true, at(5))).ok);
      assert.ok((await setTeamMemberDisabled(f.db, o2, userId, false, at(5))).ok);
    };
    return { ...f, bounce };
  };

  {
    const f = await withSecondOwner();
    const hashBefore = f.user("pu_support").password_hash;
    const racing = interleave(f.db, /UPDATE platform_users SET password_hash/, f.bounce("pu_support"));
    const changed = await changeOwnPassword(racing, f.support, { current: SUPPORT_PASSWORD, totp: await code(f.supportSecret, 1), password: "voided-change-123" }, at(1));
    assert.equal(changed.ok, false, "self change");
    assert.equal(f.user("pu_support").password_hash, hashBefore);
    assert.equal(f.events().filter((event) => event.kind === "platform_password_changed").length, 0);
  }
  {
    const f = await withSecondOwner();
    const racing = interleave(f.db, /INSERT INTO platform_users/, f.bounce("pu_owner"));
    const added = await addTeamMember(racing, f.owner, { email: "voided@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 1) }, ORIGIN, OPEN, at(1));
    assert.equal(added.ok, false, "add member");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'voided@ops.test'").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0);
  }
  {
    const f = await withSecondOwner();
    f.session("pu_support", "s_target");
    const racing = interleave(f.db, /INSERT INTO platform_credential_grants/, f.bounce("pu_owner"));
    const link = await issueCredentialGrant(racing, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 1), ORIGIN, OPEN, at(1));
    assert.equal(link.ok, false, "reset link");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0);
    assert.equal(f.open("s_target"), true, "the target's sessions are untouched");
  }
  // The same writes succeed with the authorizing session live (the fence is not a blanket refusal).
  {
    const f = await withSecondOwner();
    assert.ok((await changeOwnPassword(f.db, f.support, { current: SUPPORT_PASSWORD, totp: await code(f.supportSecret, 1), password: "allowed-change-123" }, at(1))).ok);
    assert.ok((await addTeamMember(f.db, f.owner, { email: "ok@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 1) }, ORIGIN, OPEN, at(1))).ok);
    assert.equal((await changeOwnPassword(f.db, { ...f.owner, sessionId: undefined }, { current: OWNER_PASSWORD, totp: await code(f.ownerSecret, 2), password: "no-session-123" }, at(2))).ok, false, "no authorizing session, no write");
  }
});

test("IAM-11 invariant: a role change revokes links only when its own update happened — a losing concurrent change leaves a replacement link alone", async () => {
  const f = await fixture();
  const added = await addTeamMember(f.db, f.owner, { email: "new@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 0) }, ORIGIN, OPEN, at(0));
  assert.ok(added.ok && added.value);
  const memberId = added.value!.id;
  let replacement = "";
  // Between this request's read (role = support) and its write, another change wins and a replacement link is issued.
  const racing = interleave(f.db, /UPDATE platform_users SET role/, async () => {
    assert.ok((await setTeamMemberRole(f.db, f.owner, memberId, "platform_owner", at(1))).ok);
    const link = await issueTeamMemberLink(f.db, f.owner, memberId, await code(f.ownerSecret, 1), ORIGIN, OPEN, at(1));
    assert.ok(link.ok && link.value);
    replacement = link.value!.link.split("#")[1];
  });
  const losing = await setTeamMemberRole(racing, f.owner, memberId, "platform_owner", at(2));
  assert.equal(losing.ok || losing.status, 409);
  assert.ok((await peekCredentialGrant(f.db, replacement, "198.51.100.1", OPEN, at(2))).ok, "the replacement link is still open");
  assert.equal(f.events().filter((event) => event.kind === "platform_user_role_changed").length, 1, "one change audited");
});

test("IAM-11 roll-forward rehearsal: the v13 link switch closes issuance and redemption without legacy reset, keeps the guards, and reopens only past an instant", async () => {
  const f = await fixture();
  const pending = await addTeamMember(f.db, f.owner, { email: "pending@ops.test", role: "platform_owner", totp: await code(f.ownerSecret, 0) }, ORIGIN, OPEN, at(0));
  const reset = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 1), ORIGIN, OPEN, at(1));
  assert.ok(pending.ok && reset.ok);
  const outstanding = [pending.value!.link, reset.value!.link].map((link) => link.split("#")[1]);
  f.session("pu_support", "auth_support_2"); // the reset closed support's sessions; they signed in again
  const support = { ...f.support, sessionId: "auth_support_2" };

  // Step 1 — switch off (`PLATFORM_CREDENTIAL_LINKS=off`), and fail closed on a value nobody meant.
  for (const value of ["off", "OFF", "yes", "2026-13-40T00:00Z"]) {
    const off = credentialLinkPolicy({ PLATFORM_CREDENTIAL_LINKS: value });
    assert.equal(off.open, false, value);
    for (const token of outstanding) {
      assert.equal((await peekCredentialGrant(f.db, token, "198.51.100.1", () => off, at(2))).ok, false);
      assert.equal((await consumeCredentialGrant(f.db, token, { password: "never-used-1234", totp: await code(f.supportSecret, 2) }, "198.51.100.1", () => off, at(2))).ok, false);
    }
    assert.equal((await issueTeamMemberLink(f.db, f.owner, "pu_support", await code(f.ownerSecret, 2), ORIGIN, () => off, at(2))).ok, false);
    assert.equal((await addTeamMember(f.db, f.owner, { email: "blocked@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 2) }, ORIGIN, () => off, at(2))).ok, false);
  }
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'blocked@ops.test'").get()!.n, 0);
  // No legacy flow returns: nothing resets both factors.
  assert.equal("resetTeamMemberAccess" in teamModule, false);
  // The guards stay: a pending owner does not count as the last owner; self change and its session revocation still work.
  f.db.sqlite.exec("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, disabled_at, created_at) VALUES ('pu_stale', 'stale@ops.test', 'x', 'AAAA', 'platform_owner', '2026-11-02', '2026-11-01')");
  const stale: PlatformUser = { id: "pu_stale", email: "stale@ops.test", role: "platform_owner", sessionId: "none" };
  assert.equal((await setTeamMemberDisabled(f.db, stale, "pu_owner", true, at(3))).ok, false, "the only other owner is pending: the enrolled owner stays");
  assert.ok((await changeOwnPassword(f.db, support, { current: SUPPORT_PASSWORD, totp: await code(f.supportSecret, 3), password: "during-off-1234" }, at(3))).ok);
  assert.equal(f.open("auth_support_2"), false);

  // Step 2 — reopen past an instant (`PLATFORM_CREDENTIAL_LINKS=<ISO now>`): every link from before is dead, new ones work.
  const reopenAt = at(4);
  const reopened = credentialLinkPolicy({ PLATFORM_CREDENTIAL_LINKS: reopenAt.toISOString() });
  assert.deepEqual(reopened, { open: true, notBefore: reopenAt.toISOString() });
  for (const token of outstanding) assert.equal((await peekCredentialGrant(f.db, token, "198.51.100.1", () => reopened, at(5))).ok, false, "outstanding links stay dead");
  const fresh = await issueTeamMemberLink(f.db, f.owner, pending.value!.id, await code(f.ownerSecret, 5), ORIGIN, () => reopened, at(5));
  assert.ok(fresh.ok);
  assert.ok((await peekCredentialGrant(f.db, fresh.value!.link.split("#")[1], "198.51.100.1", () => reopened, at(5))).ok);
});

test("IAM-11 backup and restore: the daily export keeps the grant table's schema and the link audit but no grant row; a restored copy reopens links only past an instant", async () => {
  const f = await fixture();
  const issued = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.ok(issued.ok);
  const token = issued.value!.link.split("#")[1];
  const { sql } = await exportPlatformDbSql(f.db);
  assert.match(sql, /CREATE TABLE platform_credential_grants/, "schema kept");
  assert.doesNotMatch(sql, /INSERT INTO "platform_credential_grants"/, "no grant row");
  assert.match(sql, /platform_access_link_issued/, "the audit of the issue is kept");

  const restored = createSqliteD1();
  restored.sqlite.exec(sql);
  assert.equal((await peekCredentialGrant(restored, token, "198.51.100.1", OPEN, at(1))).ok, false, "a link from before the copy cannot come back through the export");
  // A point-in-time restore of the database itself does bring rows back: reopening behind the restore instant keeps them dead.
  assert.ok((await peekCredentialGrant(f.db, token, "198.51.100.1", OPEN, at(1))).ok);
  const afterRestore = credentialLinkPolicy({ PLATFORM_CREDENTIAL_LINKS: at(1).toISOString() });
  assert.equal((await peekCredentialGrant(f.db, token, "198.51.100.1", () => afterRestore, at(1))).ok, false);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Expires a row "now" by the wall clock, a few ms after the request began: later than its start, earlier than its commit. */
const expireNow = async () => (await sleep(5), new Date(Date.now() - 2).toISOString());
const liveNow = (secret: string) => totpCode(secret, Math.floor(Date.now() / 30_000));

test("IAM-11 team writes: disable, enable and role change commit only while the actor is still an active owner with a live, unexpired session; otherwise nothing happens at all", async () => {
  type Op = (db: D1Database, actor: PlatformUser) => Promise<{ ok: boolean }>;
  const ops: Record<string, { op: Op; first: RegExp; setup?: (f: Awaited<ReturnType<typeof fixture>>) => void }> = {
    disable: { op: (db, actor) => setTeamMemberDisabled(db, actor, "pu_support", true), first: /UPDATE platform_users SET disabled_at = \?1/ },
    enable: {
      op: (db, actor) => setTeamMemberDisabled(db, actor, "pu_support", false),
      first: /UPDATE platform_users SET disabled_at = NULL/,
      setup: (f) => void f.db.sqlite.exec("UPDATE platform_users SET disabled_at = '2026-11-01' WHERE id = 'pu_support'"),
    },
    role: { op: (db, actor) => setTeamMemberRole(db, actor, "pu_support", "platform_owner"), first: /UPDATE platform_users SET role/ },
  };
  const losses: Record<string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>> = {
    "actor demoted": async (f) => void f.db.sqlite.exec("UPDATE platform_users SET role = 'platform_support' WHERE id = 'pu_owner'"),
    "actor disabled": async (f) => void f.db.sqlite.exec("UPDATE platform_users SET disabled_at = '2026-11-19' WHERE id = 'pu_owner'"),
    "session revoked": async (f) => void f.db.sqlite.exec("UPDATE platform_sessions SET revoked_at = '2026-11-19' WHERE id = 'auth_owner'"),
    "session expired": async (f) => void f.db.sqlite.prepare("UPDATE platform_sessions SET expires_at = ? WHERE id = 'auth_owner'").run(await expireNow()),
  };
  for (const [opName, { op, first, setup }] of Object.entries(ops)) {
    for (const [lossName, loss] of Object.entries(losses)) {
      const f = await fixture();
      // A second enrolled owner exists, so the last-owner rule never decides these cases.
      f.db.sqlite.exec("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_o2', 'o2@ops.test', 'x', 'AAAA', 'platform_owner', '2026-11-01')");
      setup?.(f);
      f.session("pu_support", "s_target");
      assert.ok((await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, OPEN, at(0))).ok || opName === "enable");
      f.session("pu_support", "s_target_2");
      const usersBefore = JSON.stringify(f.db.sqlite.prepare("SELECT id, role, disabled_at, credential_generation FROM platform_users ORDER BY id").all());
      const grantsBefore = JSON.stringify(f.db.sqlite.prepare("SELECT id, revoked_at FROM platform_credential_grants ORDER BY id").all());
      const eventsBefore = f.events().length;
      const result = await op(interleave(f.db, first, () => loss(f)), f.owner);
      const label = `${opName} / ${lossName}`;
      assert.equal(result.ok, false, label);
      const usersAfter = f.db.sqlite.prepare("SELECT id, role, disabled_at, credential_generation FROM platform_users ORDER BY id").all();
      // The loss itself may have changed the actor's own row; the target's row must not have changed.
      const targetRow = (rows: unknown) => JSON.stringify((JSON.parse(JSON.stringify(rows)) as { id: string }[]).find((row) => row.id === "pu_support"));
      assert.equal(targetRow(usersAfter), targetRow(JSON.parse(usersBefore)), `${label}: target unchanged`);
      assert.equal(JSON.stringify(f.db.sqlite.prepare("SELECT id, revoked_at FROM platform_credential_grants ORDER BY id").all()), grantsBefore, `${label}: no grant revoked`);
      assert.equal(f.open("s_target_2"), true, `${label}: target session untouched`);
      assert.equal(f.events().length, eventsBefore, `${label}: nothing audited`);
    }
  }
  // Without a loss each op commits; without an authorizing session none even starts.
  const f = await fixture();
  f.db.sqlite.exec("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_o2', 'o2@ops.test', 'x', 'AAAA', 'platform_owner', '2026-11-01')");
  assert.equal((await setTeamMemberDisabled(f.db, { ...f.owner, sessionId: undefined }, "pu_support", true)).ok, false);
  assert.equal((await setTeamMemberRole(f.db, { ...f.owner, sessionId: undefined }, "pu_support", "platform_owner")).ok, false);
  assert.ok((await setTeamMemberRole(f.db, f.owner, "pu_support", "platform_owner")).ok);
  assert.ok((await setTeamMemberDisabled(f.db, f.owner, "pu_support", true)).ok);
  assert.ok((await setTeamMemberDisabled(f.db, f.owner, "pu_support", false)).ok);
});

test("IAM-11 expiry is judged at commit by the database clock: a session or link that expires after authorization but before the write authorizes nothing", async () => {
  {
    const f = await fixture();
    const start = new Date();
    const hash = f.user("pu_support").password_hash;
    const racing = interleave(f.db, /UPDATE platform_users SET password_hash/, async () => void f.db.sqlite.prepare("UPDATE platform_sessions SET expires_at = ? WHERE id = 'auth_support'").run(await expireNow()));
    assert.equal((await changeOwnPassword(racing, f.support, { current: SUPPORT_PASSWORD, totp: await liveNow(f.supportSecret), password: "expired-change-123" }, start)).ok, false, "self change");
    assert.equal(f.user("pu_support").password_hash, hash);
  }
  {
    const f = await fixture();
    const start = new Date();
    const racing = interleave(f.db, /INSERT INTO platform_users/, async () => void f.db.sqlite.prepare("UPDATE platform_sessions SET expires_at = ? WHERE id = 'auth_owner'").run(await expireNow()));
    assert.equal((await addTeamMember(racing, f.owner, { email: "late@ops.test", role: "platform_support", totp: await liveNow(f.ownerSecret) }, ORIGIN, OPEN, start)).ok, false, "add member");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'late@ops.test'").get()!.n, 0);
  }
  {
    const f = await fixture();
    const start = new Date();
    const racing = interleave(f.db, /INSERT INTO platform_credential_grants/, async () => void f.db.sqlite.prepare("UPDATE platform_sessions SET expires_at = ? WHERE id = 'auth_owner'").run(await expireNow()));
    assert.equal((await issueCredentialGrant(racing, f.owner, "pu_support", "password_reset", await liveNow(f.ownerSecret), ORIGIN, OPEN, start)).ok, false, "reset link");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0);
  }
  {
    const f = await fixture();
    const issued = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, OPEN, at(0));
    assert.ok(issued.ok);
    const token = issued.value!.link.split("#")[1];
    const hash = f.user("pu_support").password_hash;
    const start = new Date();
    // The link expires while the redemption hashes the new password.
    const racing = interleave(f.db, /SET totp_last_step/, async () => void f.db.sqlite.prepare("UPDATE platform_credential_grants SET expires_at = ?").run(await expireNow()));
    const used = await consumeCredentialGrant(racing, token, { password: "expired-link-1234", totp: await liveNow(f.supportSecret) }, "198.51.100.1", OPEN, start);
    assert.equal(used.ok || used.status, 410, "redemption");
    assert.equal(f.user("pu_support").password_hash, hash);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants WHERE consumed_at IS NOT NULL").get()!.n, 0);
  }
});

test("IAM-11 the link switch is read again at commit: turned off, or given a later not-before, while the request is hashing or stepping up, nothing commits", async () => {
  const live = { PLATFORM_CREDENTIAL_LINKS: "" };
  const gate = () => credentialLinkPolicy(live);
  // Redemption: switched off, then (another run) moved past the link, between admission and commit.
  for (const [name, value] of [["off", "off"], ["not-before", () => new Date(Date.now() + 1000).toISOString()]] as const) {
    live.PLATFORM_CREDENTIAL_LINKS = "";
    const f = await fixture();
    const issued = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, OPEN, at(0));
    assert.ok(issued.ok);
    const hash = f.user("pu_support").password_hash;
    const racing = interleave(f.db, /SET totp_last_step/, async () => void (live.PLATFORM_CREDENTIAL_LINKS = typeof value === "string" ? value : value()));
    const used = await consumeCredentialGrant(racing, issued.value!.link.split("#")[1], { password: "switched-link-123", totp: await code(f.supportSecret, 1) }, "198.51.100.1", gate, at(1));
    assert.equal(used.ok, false, `redemption / ${name}`);
    assert.equal(f.user("pu_support").password_hash, hash, `redemption / ${name}: password unchanged`);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants WHERE consumed_at IS NOT NULL").get()!.n, 0);
  }
  // Issuance and adding a member: switched off while the owner's step-up code is being claimed.
  {
    live.PLATFORM_CREDENTIAL_LINKS = "";
    const f = await fixture();
    const racing = interleave(f.db, /SET totp_last_step/, async () => void (live.PLATFORM_CREDENTIAL_LINKS = "off"));
    const link = await issueCredentialGrant(racing, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, gate, at(0));
    assert.equal(link.ok || link.status, 503);
    live.PLATFORM_CREDENTIAL_LINKS = "";
    const racing2 = interleave(f.db, /SET totp_last_step/, async () => void (live.PLATFORM_CREDENTIAL_LINKS = "off"));
    const added = await addTeamMember(racing2, f.owner, { email: "switched@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 1) }, ORIGIN, gate, at(1));
    assert.equal(added.ok || added.status, 503);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'switched@ops.test'").get()!.n, 0);
  }
});

test("IAM-11 add member is all or nothing even when authority lapses between the batch's statements: one decision (the member insert), the grant follows it", async () => {
  // Fixture: a temporary trigger runs inside the batch right after the member row is written, before the grant insert —
  // the session expires there, or the actor is disabled there. Fixture data only.
  const lapses: Record<string, string> = {
    "session expires": "UPDATE platform_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'auth_owner'",
    "actor disabled": "UPDATE platform_users SET disabled_at = '2026-11-19' WHERE id = 'pu_owner'",
  };
  for (const [name, lapse] of Object.entries(lapses)) {
    const f = await fixture();
    f.db.sqlite.exec(`CREATE TEMP TRIGGER lapse_between_statements AFTER INSERT ON platform_users WHEN NEW.email = 'between@ops.test' BEGIN ${lapse}; END`);
    const added = await addTeamMember(f.db, f.owner, { email: "between@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 0) }, ORIGIN, OPEN, at(0));
    const members = f.db.sqlite.prepare("SELECT id FROM platform_users WHERE email = 'between@ops.test'").all() as { id: string }[];
    const grants = f.db.sqlite.prepare("SELECT g.id FROM platform_credential_grants g JOIN platform_users u ON u.id = g.user_id WHERE u.email = 'between@ops.test' AND g.purpose = 'enrollment' AND g.revoked_at IS NULL").all();
    // Authorized at the member insert, so the add stands — whole: one member, one open enrollment grant, both audit rows.
    assert.ok(added.ok, `${name}: decided at the member insert`);
    assert.equal(members.length, 1, name);
    assert.equal(grants.length, 1, `${name}: the member is never left without its grant`);
    assert.deepEqual(f.events().filter((event) => /platform_user_added|platform_access_link_issued/.test(event.kind)).map((event) => event.kind), ["platform_user_added", "platform_access_link_issued"], name);
  }
  // And when the decision itself refuses (authority already gone at the member insert), nothing at all is written.
  const f = await fixture();
  f.db.sqlite.exec("UPDATE platform_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'auth_owner'");
  const refused = await addTeamMember(f.db, f.owner, { email: "between@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 0) }, ORIGIN, OPEN, at(0));
  assert.equal(refused.ok || refused.status, 403);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'between@ops.test'").get()!.n, 0);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, 0);
  assert.deepEqual(f.events(), []);
});

// ---- Sol review of PR #55 (2026-11-22): one test per finding ----

test("Sol P1: a not-before cutoff later than the issuance time refuses the link before anything is written (reset link and add member)", async () => {
  const later = (now: Date) => () => credentialLinkPolicy({ PLATFORM_CREDENTIAL_LINKS: new Date(now.getTime() + 60_000).toISOString() });
  {
    const f = await fixture();
    f.session("pu_support", "kept");
    const before = { grants: f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, events: f.events().length };
    const result = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, later(at(0)), at(0));
    assert.equal(result.ok || result.status, 503, "a link born before the cutoff is refused");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants").get()!.n, before.grants, "no grant");
    assert.equal(f.events().length, before.events, "no audit row");
    assert.equal(f.open("kept"), true, "the target's sessions are not revoked for a dead link");
  }
  {
    const f = await fixture();
    const added = await addTeamMember(f.db, f.owner, { email: "late@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 0) }, ORIGIN, later(at(0)), at(0));
    assert.equal(added.ok || added.status, 503, "no member with a link that could never be used");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = 'late@ops.test'").get()!.n, 0);
  }
  {
    // A cutoff already in the past does not block new links.
    const f = await fixture();
    const past = () => credentialLinkPolicy({ PLATFORM_CREDENTIAL_LINKS: new Date(at(0).getTime() - 60_000).toISOString() });
    const ok = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, past, at(0));
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.ok((await peekCredentialGrant(f.db, tokenOf(ok.value!.link), "198.51.100.1", past, at(0))).ok, "and that link is redeemable");
  }
});

test("Sol P2: disabling or demoting an owner revokes the open links that owner issued; other owners' links stay", async () => {
  const f = await fixture();
  const secondSecret = newTotpSecret();
  f.db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_owner2', 'owner2@ops.test', ?, ?, 'platform_owner', ?)").run(await hashAdminPassword(OWNER_PASSWORD), secondSecret, at(-100).toISOString());
  f.session("pu_owner2", "auth_owner2");
  const owner2: PlatformUser = { id: "pu_owner2", email: "owner2@ops.test", role: "platform_owner", sessionId: "auth_owner2" };
  // owner2 (later compromised) invites a pending second owner; owner invites a support member.
  const byOwner2 = await addTeamMember(f.db, owner2, { email: "pending-owner@ops.test", role: "platform_owner", totp: await code(secondSecret, 0) }, ORIGIN, OPEN, at(0));
  const byOwner = await addTeamMember(f.db, f.owner, { email: "pending-cs@ops.test", role: "platform_support", totp: await code(f.ownerSecret, 1) }, ORIGIN, OPEN, at(1));
  assert.ok(byOwner2.ok && byOwner.ok);
  const disabled = await setTeamMemberDisabled(f.db, f.owner, "pu_owner2", true, at(2));
  assert.ok(disabled.ok, JSON.stringify(disabled));
  assert.equal((await peekCredentialGrant(f.db, tokenOf(byOwner2.value!.link), "198.51.100.1", OPEN, at(2))).ok, false, "the disabled owner's outstanding link is dead");
  assert.ok((await peekCredentialGrant(f.db, tokenOf(byOwner.value!.link), "198.51.100.1", OPEN, at(2))).ok, "another owner's link stays");

  // Demotion: same rule.
  const g = await fixture();
  g.db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_owner2', 'owner2@ops.test', ?, ?, 'platform_owner', ?)").run(await hashAdminPassword(OWNER_PASSWORD), secondSecret, at(-100).toISOString());
  g.session("pu_owner2", "auth_owner2");
  const issued = await addTeamMember(g.db, owner2, { email: "pending2@ops.test", role: "platform_support", totp: await code(secondSecret, 3) }, ORIGIN, OPEN, at(3));
  assert.ok(issued.ok);
  const demoted = await setTeamMemberRole(g.db, g.owner, "pu_owner2", "platform_support", at(4));
  assert.ok(demoted.ok, JSON.stringify(demoted));
  assert.equal((await peekCredentialGrant(g.db, tokenOf(issued.value!.link), "198.51.100.1", OPEN, at(4))).ok, false, "a demoted owner's outgoing link is dead");
  // A promotion revokes nothing the member issued.
  const h = await fixture();
  const promote = await setTeamMemberRole(h.db, h.owner, "pu_support", "platform_owner", at(5));
  assert.ok(promote.ok);
});

test("Sol P2: a pending operator and an unknown address cost the same full password derivation", async () => {
  const { loginVerifierHash, DUMMY_PASSWORD_HASH } = await import("./admin/session.ts");
  const { NOT_ENROLLED_HASH } = await import("./admin/credentials.ts");
  assert.equal(loginVerifierHash(NOT_ENROLLED_HASH), DUMMY_PASSWORD_HASH, "the pending sentinel runs the dummy derivation");
  assert.equal(loginVerifierHash(undefined), DUMMY_PASSWORD_HASH, "an unknown address too");
  assert.equal(loginVerifierHash(null), DUMMY_PASSWORD_HASH);
  const real = await hashAdminPassword("operator-password-1");
  assert.equal(loginVerifierHash(real), real, "an enrolled account verifies against its own hash");
  // The dummy is a well-formed hash at the real iteration count: the derivation runs, and never matches.
  assert.match(DUMMY_PASSWORD_HASH, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPasswordHash("anything", DUMMY_PASSWORD_HASH), false);
});

test("Sol P2: a reset link's code attempts share one budget across addresses; exhausting it does not consume the link", async () => {
  const { GRANT_TOTP_ATTEMPTS } = await import("./admin/credentials.ts");
  const f = await fixture();
  const issued = await issueCredentialGrant(f.db, f.owner, "pu_support", "password_reset", await code(f.ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.ok(issued.ok);
  const token = tokenOf(issued.value!.link);
  for (let attempt = 0; attempt < GRANT_TOTP_ATTEMPTS; attempt += 1) {
    const wrong = await consumeCredentialGrant(f.db, token, { password: "budget-password-12", totp: "000000" }, `198.51.100.${10 + attempt}`, OPEN, at(1));
    assert.equal(wrong.ok || wrong.status, 401, `attempt ${attempt + 1} from its own address`);
  }
  const next = await consumeCredentialGrant(f.db, token, { password: "budget-password-12", totp: await code(f.supportSecret, 1) }, "203.0.113.99", OPEN, at(1));
  assert.equal(next.ok || next.status, 429, "a fresh address with a correct code is still refused: the budget belongs to the link");
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_credential_grants WHERE consumed_at IS NOT NULL").get()!.n, 0, "the link is not consumed");
  // Fail closed: a store error on the budget refuses.
  const g = await fixture();
  const again = await issueCredentialGrant(g.db, g.owner, "pu_support", "password_reset", await code(g.ownerSecret, 0), ORIGIN, OPEN, at(0));
  assert.ok(again.ok);
  g.db.failWhen = /platform-grant-totp|rate_limits/;
  const original = console.error;
  console.error = () => undefined;
  try {
    const refused = await consumeCredentialGrant(g.db, tokenOf(again.value!.link), { password: "budget-password-12", totp: await code(g.supportSecret, 1) }, "198.51.100.50", OPEN, at(1));
    assert.equal(refused.ok, false, "no budget, no attempt");
  } finally {
    console.error = original;
    g.db.failWhen = null;
  }
});

test("Sol P3: a JSON body that is not an object is a 400 on the redemption and the password-change endpoints", async () => {
  const aksesRoute = await import("../pages/api/platform/akses.ts");
  const passwordRoute = await import("../pages/api/platform/account/password.ts");
  const f = await fixture();
  const env = { PLATFORM_DB: f.db };
  for (const raw of ["null", "[]", '"text"', "7"]) {
    const request = new Request(`${ORIGIN}/api/platform/akses`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    const response = await aksesRoute.POST({ request, locals: { runtimeEnv: env } } as never);
    assert.equal(response.status, 400, `akses ${raw}`);
    const own = new Request(`${ORIGIN}/api/platform/account/password`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    const changed = await passwordRoute.POST({ request: own, locals: { runtimeEnv: env, platformUser: f.support }, cookies: { delete: () => undefined } } as never);
    assert.equal(changed.status, 400, `password ${raw}`);
  }
});
