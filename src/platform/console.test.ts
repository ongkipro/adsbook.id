// T-52 (UX-7…UX-10): the platform console's read models and team rules,
// against the real control-plane chain on SQLite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";
import {
  actionItems,
  dailySeries,
  describeEvent,
  isStuckHost,
  listActivity,
  listPlatformInvoices,
  overviewKpis,
  ownerWhatsAppLink,
  previewLeads,
  subscriptionWindows,
  wibDay,
  wibMonthStart,
} from "./admin/metrics.ts";
import * as teamModule from "./admin/team.ts";
import { addTeamMember, issueTeamMemberLink, listTeam, setTeamMemberDisabled, setTeamMemberRole } from "./admin/team.ts";
import { credentialLinkPolicy, NOT_ENROLLED_HASH } from "./admin/credentials.ts";
import { listTenants } from "./admin/tenants.ts";
import type { PlatformUser } from "./admin/session.ts";
import { totpCode } from "./admin/totp.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
// 2026-12-01 03:00 WIB = 2026-11-30 20:00 UTC: inside December in WIB, still November in UTC.
const NOW = new Date("2026-11-30T20:00:00.000Z");
const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

async function controlPlane() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  const tenant = (id: string, fields: Record<string, unknown> = {}) => {
    const row = { id, slug: id, owner_email: `${id}@example.test`, status: "active", created_at: iso(-10 * DAY), is_demo: 0, ...fields };
    const keys = Object.keys(row);
    db.sqlite.prepare(`INSERT INTO tenants (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
  };
  const invoice = (id: string, tenantId: string, fields: Record<string, unknown> = {}) => {
    const row = {
      id, invoice_number: `ADB-${id}`, tenant_id: tenantId, cycle_code: "1m", days: 30, amount_idr: 149000, total_idr: 149000,
      channel_code: "QRIS", status: "paid", expires_at: iso(DAY), paid_at: iso(-DAY), created_at: iso(-DAY), ...fields,
    };
    const keys = Object.keys(row);
    db.sqlite.prepare(`INSERT INTO subscription_invoices (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
  };
  return { db, tenant, invoice };
}

test("WIB periods: the month and the day turn at 00:00 WIB, not UTC", () => {
  assert.equal(wibMonthStart(NOW).toISOString(), "2026-11-30T17:00:00.000Z", "December 1 WIB starts 17:00 UTC on Nov 30");
  assert.equal(wibMonthStart(NOW, 1).toISOString(), "2026-10-31T17:00:00.000Z");
  assert.equal(wibDay(NOW), "2026-12-01");
  assert.equal(wibDay("2026-11-30T16:59:59.000Z"), "2026-11-30");
});

test("UX-7 KPIs: paying stores, WIB month revenue, MRR from the latest paid invoice, conversion; demo excluded", async () => {
  const { db, tenant, invoice } = await controlPlane();
  // Paying: one annual, one in grace on a monthly plan, one granted-only (no invoice).
  tenant("annual", { subscription_ends_at: iso(200 * DAY), grace_ends_at: iso(202 * DAY) });
  tenant("grace", { subscription_ends_at: iso(-DAY), grace_ends_at: iso(DAY) });
  tenant("granted", { subscription_ends_at: iso(20 * DAY), grace_ends_at: iso(22 * DAY) });
  tenant("lapsed", { subscription_ends_at: iso(-10 * DAY), grace_ends_at: iso(-8 * DAY) });
  tenant("preview");
  tenant("demo", { is_demo: 1, subscription_ends_at: iso(300 * DAY), grace_ends_at: iso(302 * DAY) });
  tenant("half", { status: "provisioning" });
  // annual: an older monthly invoice, then the annual one — the latest decides MRR.
  invoice("a1", "annual", { paid_at: "2026-10-05T03:00:00.000Z", created_at: "2026-10-05T03:00:00.000Z" });
  invoice("a2", "annual", { cycle_code: "12m", days: 365, amount_idr: 1490000, total_idr: 1490000, paid_at: "2026-11-30T18:00:00.000Z" });
  invoice("g1", "grace", { paid_at: "2026-11-10T03:00:00.000Z" });
  invoice("l1", "lapsed", { paid_at: "2026-10-31T18:00:00.000Z" }); // Nov 1 01:00 WIB, still October in UTC
  invoice("p1", "preview", { status: "pending", paid_at: null });

  const kpis = await overviewKpis(db, NOW);
  assert.equal(kpis.payingStores, 3, "annual, grace, granted; never lapsed, preview or demo");
  assert.equal(kpis.inGrace, 1);
  assert.equal(kpis.collectedThisMonth, 1490000, "18:00 UTC Nov 30 is December 1 in WIB");
  assert.equal(kpis.collectedLastMonth, 149000 * 2, "November WIB: grace and the lapsed store's payment");
  assert.equal(kpis.estimatedMrr, Math.round(1490000 * 30 / 365 + 149000), "latest paid invoice each; granted-only counts 0");
  assert.equal(kpis.activated, 5, "provisioning and demo excluded");
  assert.equal(kpis.everSubscribed, 4, "annual, grace, granted, lapsed");
});

test("UX-7 action list, Preview leads and the daily series", async () => {
  const { db, tenant, invoice } = await controlPlane();
  tenant("ending", { subscription_ends_at: iso(3 * DAY), grace_ends_at: iso(5 * DAY) });
  tenant("grace", { subscription_ends_at: iso(-DAY), grace_ends_at: iso(DAY) });
  tenant("later", { subscription_ends_at: iso(30 * DAY), grace_ends_at: iso(32 * DAY) });
  tenant("lead", { owner_whatsapp: "6281234567890", created_at: iso(-2 * DAY) });
  tenant("doomed", { purge_after: iso(20 * DAY) });
  invoice("slow", "lead", { status: "pending", paid_at: null, created_at: iso(-2 * 3_600_000), expires_at: iso(DAY) });
  invoice("fresh", "lead", { status: "pending", paid_at: null, created_at: iso(-60_000), expires_at: iso(DAY) });
  db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, created_at) VALUES ('toko.example', 'lead', 'custom', 'pending', ?)").run(iso(-2 * DAY));
  db.sqlite.prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, created_at) VALUES ('baru.example', 'later', 'custom', 'pending', ?)").run(iso(-3_600_000));
  for (const id of ["ending", "grace", "later", "lead", "doomed"]) {
    db.sqlite.prepare("INSERT INTO tenant_health (tenant_id, heartbeat_at) VALUES (?, ?)").run(id, iso(-60_000));
  }

  const items = await actionItems(db, NOW);
  const kinds = items.map((item) => `${item.kind}:${item.slug}`).sort();
  assert.deepEqual(kinds, ["domain:lead", "ending:ending", "grace:grace", "invoice:lead", "purge:doomed"]);

  const leads = await previewLeads(db);
  assert.deepEqual(leads.map((lead) => lead.slug), ["lead", "doomed"], "never-paid active stores, newest first");
  assert.match(ownerWhatsAppLink(leads[0].owner_whatsapp, "lead") ?? "", /^https:\/\/wa\.me\/6281234567890\?text=/);
  assert.equal(ownerWhatsAppLink("08123", "x"), null);
  assert.equal(ownerWhatsAppLink(null, "x"), null);

  invoice("paid-today", "later", { paid_at: iso(-3_600_000) });
  const series = await dailySeries(db, NOW, 30);
  assert.equal(series.length, 30);
  assert.equal(series[29].day, "2026-12-01");
  assert.equal(series[29].paid, 1);
  assert.equal(series.reduce((sum, point) => sum + point.signups, 0), 5, "every store here was created inside the 30 days");
  assert.equal(series[27].signups, 1, "the lead, two WIB days ago");
});

test("UX-8 calendar windows and the invoice list search", async () => {
  const { db, tenant, invoice } = await controlPlane();
  tenant("soon", { subscription_ends_at: iso(10 * DAY), grace_ends_at: iso(12 * DAY) });
  tenant("grace", { subscription_ends_at: iso(-DAY), grace_ends_at: iso(DAY) });
  tenant("gone", { subscription_ends_at: iso(-10 * DAY), grace_ends_at: iso(-8 * DAY) });
  tenant("old", { subscription_ends_at: iso(-60 * DAY), grace_ends_at: iso(-58 * DAY) });
  const windows = await subscriptionWindows(db, NOW);
  assert.deepEqual([windows.ending, windows.grace, windows.expired].map((rows) => rows.map((row) => row.slug)), [["soon"], ["grace"], ["gone"]]);

  invoice("x1", "soon", { invoice_number: "ADB-20261130-AAAA" });
  invoice("x2", "grace", { invoice_number: "ADB-20261130-BBBB", status: "pending", paid_at: null });
  assert.deepEqual((await listPlatformInvoices(db, { search: "bbbb" })).map((row) => row.slug), ["grace"], "invoice number, case-insensitive");
  assert.deepEqual((await listPlatformInvoices(db, { search: "SOON" })).map((row) => row.invoice_number), ["ADB-20261130-AAAA"], "slug");
  assert.deepEqual((await listPlatformInvoices(db, { status: "pending" })).map((row) => row.slug), ["grace"]);
  assert.equal((await listPlatformInvoices(db, { status: "bogus" })).length, 2, "an unknown status filter is ignored, not injected");
});

test("UX-4 list: billing axis filter and owner-email search", async () => {
  const { db, tenant } = await controlPlane();
  tenant("pv", { owner_email: "budi@toko.test" });
  tenant("sub", { subscription_ends_at: iso(5 * DAY), grace_ends_at: iso(7 * DAY) });
  tenant("gr", { subscription_ends_at: iso(-DAY), grace_ends_at: iso(DAY) });
  tenant("ex", { subscription_ends_at: iso(-9 * DAY), grace_ends_at: iso(-7 * DAY) });
  const slugs = async (filter: Parameters<typeof listTenants>[1]) => (await listTenants(db, filter, NOW)).map((row) => row.slug).sort();
  assert.deepEqual(await slugs({ billing: "preview" }), ["pv"]);
  assert.deepEqual(await slugs({ billing: "subscribed" }), ["sub"]);
  assert.deepEqual(await slugs({ billing: "grace" }), ["gr"]);
  assert.deepEqual(await slugs({ billing: "expired" }), ["ex"]);
  assert.deepEqual(await slugs({ search: "budi@" }), ["pv"]);
  assert.equal((await slugs({ billing: "nope" })).length, 4);
});

test("UX-9 domains and activity: stuck hosts, filters, cursor, readable detail", async () => {
  const { db, tenant } = await controlPlane();
  assert.equal(isStuckHost({ status: "pending", created_at: iso(-25 * 3_600_000) }, NOW), true);
  assert.equal(isStuckHost({ status: "pending", created_at: iso(-3_600_000) }, NOW), false);
  assert.equal(isStuckHost({ status: "active", created_at: iso(-30 * DAY) }, NOW), false);

  tenant("a");
  tenant("b");
  const insert = db.sqlite.prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, ?, ?, ?, ?)");
  for (let index = 0; index < 105; index += 1) insert.run("a", "signup", "a@example.test", iso(-index * 60_000), null);
  insert.run("b", "suspended", "platform:pu_x", iso(0), JSON.stringify({ reason: "spam", before: "active", after: "suspended" }));
  insert.run("_platform", "platform_user_added", "platform:pu_x", iso(0), JSON.stringify({ email: "cs@ops.test", role: "platform_support", password_hash: "never shown" }));

  const first = await listActivity(db, {});
  assert.equal(first.rows.length, 100);
  assert.ok(first.nextBefore);
  const second = await listActivity(db, { before: first.nextBefore });
  assert.equal(second.rows.length, 7);
  assert.equal(second.nextBefore, null);
  assert.deepEqual((await listActivity(db, { kind: "suspended" })).rows.map((row) => row.slug), ["b"]);
  assert.deepEqual((await listActivity(db, { slug: "platform" })).rows.map((row) => row.kind), ["platform_user_added"]);
  assert.equal((await listActivity(db, { kind: "x'; DROP" })).rows.length, 100, "a malformed kind is ignored");

  assert.equal(describeEvent(JSON.stringify({ reason: "spam", before: "active", after: "suspended" })), "aktif → ditangguhkan · alasan: spam");
  assert.equal(describeEvent(JSON.stringify({ email: "cs@ops.test", role: "platform_support", password_hash: "x" })), "cs@ops.test · Support", "unknown keys never shown");
  assert.equal(describeEvent(JSON.stringify({ email: "a@ops.test", before: "platform_owner", after: "platform_support" })), "a@ops.test · Owner → Support");
  assert.equal(describeEvent("not json"), "");
});

// Real TOTP secrets: every credential action on the team is stepped up with the owner's own fresh code (IAM-11).
const OWNER_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const stepAt = (offset: number) => new Date(NOW.getTime() + offset * 30_000);
const codeAt = (secret: string, offset: number) => totpCode(secret, Math.floor(stepAt(offset).getTime() / 30_000));
const ORIGIN = "https://app.adsbook.id";
const OPEN = () => credentialLinkPolicy({});
const liveSession = (db: Awaited<ReturnType<typeof controlPlane>>["db"], userId: string) => {
  db.sqlite.prepare("INSERT INTO platform_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(`auth_${userId}`, userId, iso(400 * DAY), iso(-DAY));
  return `auth_${userId}`;
};

test("UX-10 team: owner only, step-up, a new member is created unenrolled with a link, no self-disable, last enrolled owner kept, sessions and links revoked, every change audited", async () => {
  const { db } = await controlPlane();
  db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_owner', 'owner@ops.test', 'x', ?, 'platform_owner', ?)").run(OWNER_SECRET, iso(-DAY));
  const owner: PlatformUser = { id: "pu_owner", email: "owner@ops.test", role: "platform_owner", sessionId: liveSession(db, "pu_owner") };
  const support: PlatformUser = { id: "pu_s", email: "s@ops.test", role: "platform_support" };

  const refused = await addTeamMember(db, support, { email: "x@ops.test", role: "platform_support", totp: await codeAt(OWNER_SECRET, 0) }, ORIGIN, OPEN, stepAt(0));
  assert.equal(refused.ok || refused.status, 403);
  assert.equal((await addTeamMember(db, owner, { email: "bad", role: "platform_support", totp: await codeAt(OWNER_SECRET, 0) }, ORIGIN, OPEN, stepAt(0))).ok, false);
  assert.equal((await addTeamMember(db, owner, { email: "x@ops.test", role: "root", totp: await codeAt(OWNER_SECRET, 0) }, ORIGIN, OPEN, stepAt(0))).ok, false);
  const noStepUp = await addTeamMember(db, owner, { email: "x@ops.test", role: "platform_support", totp: "000000" }, ORIGIN, OPEN, stepAt(0));
  assert.equal(noStepUp.ok || noStepUp.status, 401, "no member without the owner's own code");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_users").get()!.n, 1);

  const added = await addTeamMember(db, owner, { email: " CS@Ops.Test ", role: "platform_support", totp: await codeAt(OWNER_SECRET, 0) }, ORIGIN, OPEN, stepAt(0));
  assert.ok(added.ok && added.value);
  if (!added.ok || !added.value) return;
  assert.equal(added.value.email, "cs@ops.test");
  assert.match(added.value.link, /^https:\/\/app\.adsbook\.id\/platform\/akses#[0-9a-f]{64}$/, "the token is in the fragment, never in a path or query");
  const replay = await addTeamMember(db, owner, { email: "y@ops.test", role: "platform_support", totp: await codeAt(OWNER_SECRET, 0) }, ORIGIN, OPEN, stepAt(0));
  assert.equal(replay.ok || replay.status, 401, "a step-up code works once");
  const stored = db.sqlite.prepare("SELECT password_hash, totp_secret FROM platform_users WHERE id = ?").get(added.value.id) as { password_hash: string; totp_secret: string | null };
  assert.equal(stored.password_hash, NOT_ENROLLED_HASH, "no password until the member sets one");
  assert.equal(stored.totp_secret, null, "no authenticator until the member proves one");
  assert.equal((await addTeamMember(db, owner, { email: "cs@ops.test", role: "platform_owner", totp: await codeAt(OWNER_SECRET, 1) }, ORIGIN, OPEN, stepAt(1))).ok, false, "email unique");
  const team = await listTeam(db);
  const token = added.value.link.split("#")[1];
  assert.ok(!JSON.stringify(team).includes(token), "the list never carries a link");
  assert.equal(team.find((row) => row.id === added.value!.id)?.mfa, 0, "shown as not yet enrolled");

  db.sqlite.prepare("INSERT INTO platform_sessions (id, user_id, expires_at, created_at) VALUES ('s1', ?, ?, ?)").run(added.value.id, iso(DAY), iso(-60_000));
  assert.equal((await setTeamMemberDisabled(db, support, added.value.id, true)).ok, false, "support cannot");
  assert.equal((await setTeamMemberDisabled(db, owner, "pu_owner", true)).ok, false, "never yourself");
  assert.ok((await setTeamMemberDisabled(db, owner, added.value.id, true, NOW)).ok);
  const session = db.sqlite.prepare("SELECT revoked_at FROM platform_sessions WHERE id = 's1'").get() as { revoked_at: string | null };
  assert.equal(session.revoked_at, NOW.toISOString(), "sessions closed with the disable");
  const grant = db.sqlite.prepare("SELECT revoked_at FROM platform_credential_grants WHERE user_id = ?").get(added.value.id) as { revoked_at: string | null };
  assert.equal(grant.revoked_at, NOW.toISOString(), "the open enrollment link dies with the disable");
  assert.ok((await setTeamMemberDisabled(db, owner, added.value.id, false, NOW)).ok);

  // A second, not yet enrolled owner does not count: it cannot sign in, so it cannot keep the console reachable.
  const second = await addTeamMember(db, owner, { email: "o2@ops.test", role: "platform_owner", totp: await codeAt(OWNER_SECRET, 2) }, ORIGIN, OPEN, stepAt(2));
  assert.ok(second.ok && second.value);
  if (!second.ok || !second.value) return;
  db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_other', 'other@ops.test', 'x', 'CCCC', 'platform_owner', ?)").run(iso(0));
  const other: PlatformUser = { id: "pu_other", email: "other@ops.test", role: "platform_owner", sessionId: liveSession(db, "pu_other") };
  db.sqlite.prepare("UPDATE platform_users SET disabled_at = ? WHERE id = 'pu_other'").run(iso(0));
  // Only pu_owner is an active enrolled owner; a stale owner (disabled, session row still present) cannot disable or demote
  // it, though o2 (pending) is "active": the actor fence and the enrolled-owner count both refuse.
  const last = await setTeamMemberDisabled(db, other, "pu_owner", true, NOW);
  assert.equal(last.ok || last.status, 409, "the last active enrolled owner stays");
  const lastRole = await setTeamMemberRole(db, other, "pu_owner", "platform_support", NOW);
  assert.equal(lastRole.ok || lastRole.status, 409, "nor demoted while only a pending owner remains");

  const audit = db.sqlite.prepare("SELECT kind, actor, detail_json FROM tenant_events WHERE tenant_id = '_platform' ORDER BY id").all() as { kind: string; actor: string; detail_json: string }[];
  assert.deepEqual(audit.map((row) => row.kind), ["platform_user_added", "platform_access_link_issued", "platform_user_disabled", "platform_user_enabled", "platform_user_added", "platform_access_link_issued"]);
  assert.ok(audit.every((row) => row.actor.startsWith("platform:pu_")));
  assert.ok(audit.every((row) => !row.detail_json.includes(token) && !row.detail_json.includes(OWNER_SECRET)));
  assert.deepEqual(JSON.parse(audit[2].detail_json), { user: added.value.id, email: "cs@ops.test", role: "platform_support", before: "active", after: "disabled" });
});

test("UX-10 team: change role keeps an active owner, never your own, and revokes open links; the legacy both-factor reset is gone", async () => {
  const { db } = await controlPlane();
  db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES ('pu_a', 'a@ops.test', 'x', ?, 'platform_owner', ?), ('pu_b', 'b@ops.test', 'x', 'BBBB', 'platform_support', ?)").run(OWNER_SECRET, iso(-DAY), iso(-DAY));
  const a: PlatformUser = { id: "pu_a", email: "a@ops.test", role: "platform_owner", sessionId: liveSession(db, "pu_a") };
  const b: PlatformUser = { id: "pu_b", email: "b@ops.test", role: "platform_support" };
  const roleOf = (id: string) => (db.sqlite.prepare("SELECT role FROM platform_users WHERE id = ?").get(id) as { role: string }).role;

  assert.equal((await setTeamMemberRole(db, b, "pu_a", "platform_support")).ok, false, "support cannot");
  assert.equal((await setTeamMemberRole(db, a, "pu_a", "platform_support")).ok, false, "never your own role");
  assert.equal((await setTeamMemberRole(db, a, "pu_b", "root")).ok, false, "unknown role");
  assert.equal((await setTeamMemberRole(db, a, "pu_b", "platform_support")).ok, false, "unchanged role");

  const link = await issueTeamMemberLink(db, a, "pu_b", await codeAt(OWNER_SECRET, 0), ORIGIN, OPEN, stepAt(0));
  assert.ok(link.ok && link.value?.purpose === "password_reset");
  assert.ok((await setTeamMemberRole(db, a, "pu_b", "platform_owner", NOW)).ok);
  assert.equal(roleOf("pu_b"), "platform_owner");
  const grant = db.sqlite.prepare("SELECT revoked_at FROM platform_credential_grants WHERE user_id = 'pu_b'").get() as { revoked_at: string | null };
  assert.equal(grant.revoked_at, NOW.toISOString(), "a link issued under the old role does not outlive it");

  // Now b demotes a: allowed while b stays an active owner.
  const bOwner: PlatformUser = { ...b, role: "platform_owner", sessionId: liveSession(db, "pu_b") };
  assert.ok((await setTeamMemberRole(db, bOwner, "pu_a", "platform_support", NOW)).ok);
  db.sqlite.prepare("INSERT INTO platform_users (id, email, password_hash, role, disabled_at, created_at) VALUES ('pu_c', 'c@ops.test', 'x', 'platform_owner', ?, ?)").run(iso(0), iso(0));
  const c: PlatformUser = { id: "pu_c", email: "c@ops.test", role: "platform_owner", sessionId: liveSession(db, "pu_c") };
  const last = await setTeamMemberRole(db, c, "pu_b", "platform_support", NOW);
  assert.equal(last.ok || last.status, 409, "the last active owner keeps the role");
  assert.equal(roleOf("pu_b"), "platform_owner");

  assert.equal("resetTeamMemberAccess" in teamModule, false, "no action resets both factors (IAM-11 cutover)");
  const audit = db.sqlite.prepare("SELECT kind FROM tenant_events WHERE tenant_id = '_platform' ORDER BY id").all() as { kind: string }[];
  assert.deepEqual(audit.map((event) => event.kind), ["platform_access_link_issued", "platform_user_role_changed", "platform_user_role_changed"]);
});
