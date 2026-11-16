// ADR-041 (T-49): Option A, the billing states, the platform AutoLaris rail,
// and the money invariants — a paid invoice credits its days exactly once,
// early renewal keeps remaining days, and only an explicit Advice settlement
// (or an audited grant) moves a store to subscribed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  BILLING_CYCLES,
  autoLarisExpiry,
  billingState,
  checkInvoice,
  createInvoice,
  grantSubscription,
  pollOpenInvoices,
  settleInvoice,
  subscriptionRefusal,
} from "./billing.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
const ENV = { PLATFORM_AUTOLARIS_API_KEY: "platform-key", PLATFORM_AUTOLARIS_BASE_URL: "https://autolaris.test", PLATFORM_AUTOLARIS_WEBHOOK_TOKEN: "hook-token" };
const NOW = new Date("2026-11-20T03:00:00.000Z");
const DAY = 86_400_000;

async function platform() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-a', 'toko-a', 'a@example.test', 'active', '2026-11-16')").run();
  db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-b', 'toko-b', 'b@example.test', 'active', '2026-11-16')").run();
  const tenant = (id = "t-a") =>
    ({ ...(db.sqlite.prepare("SELECT subscription_ends_at, grace_ends_at, cache_version FROM tenants WHERE id = ?").get(id) as object) }) as {
      subscription_ends_at: string | null;
      grace_ends_at: string | null;
      cache_version: number;
    };
  const events = (kind: string) => (db.sqlite.prepare("SELECT tenant_id, actor, detail_json FROM tenant_events WHERE kind = ?").all(kind) as object[]).map((row) => ({ ...row })) as { tenant_id: string; actor: string; detail_json: string }[];
  return { db, tenant, events };
}

type Call = { url: string; auth: string | null; body: Record<string, unknown> | null };
function fakeAutoLaris(options: { advice?: { rc: string; ket: string }; create?: (body: Record<string, unknown>) => unknown } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, auth: headers.get("authorization"), body });
    if (url.endsWith("/api/h2h/list_payment")) {
      return Response.json({ rc: "00", data: [
        { channel_code: "COD", name: "COD", admin: "0", tipe_admin: "fix" },
        { channel_code: "QRIS", name: "QRIS", admin: "0.7", tipe_admin: "persen" },
        { channel_code: "VABCA", name: "BCA", admin: "4000", tipe_admin: "fix" },
        { channel_code: "OVO", name: "OVO", admin: "3", tipe_admin: "persen" },
      ] });
    }
    if (url.endsWith("/api/h2h/create_payment")) {
      return Response.json(options.create ? options.create(body!) : {
        rc: "00", ket: "Sukses",
        data: { trx_id: `trx-${calls.length}`, virtual_account: body!.channel_code === "VABCA" ? "8779611150001393" : "", qr: body!.channel_code === "QRIS" ? "00020101021226…6304ABCD" : "", url: "", amount: Number(body!.amount), admin: 4000, total: Number(body!.amount) + 4000 },
      });
    }
    if (url.endsWith("/api/h2h/advice")) return Response.json(options.advice ?? { rc: "02", ket: "PENDING" });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

/** checkInvoice uses the shared AutoLarisClient, which calls the global fetch. */
async function withGlobalFetch<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const customer = { name: "Toko A", email: "a@example.test", phone: "081234567890" };

test("Option A: four cycles, exact IDR and days", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BILLING_CYCLES).map(([code, cycle]) => [code, [cycle.days, cycle.amountIdr]])),
    { "1m": [30, 149_000], "3m": [90, 399_000], "6m": [180, 759_000], "12m": [365, 1_490_000] },
  );
});

test("BILL-5 states: preview with no end, subscribed before it, 48 hours of grace, then expired", () => {
  const ends = "2026-11-20T03:00:00.000Z";
  const grace = "2026-11-22T03:00:00.000Z";
  assert.equal(billingState({ subscriptionEndsAt: null }, NOW), "preview");
  assert.equal(billingState({ subscriptionEndsAt: ends, graceEndsAt: grace }, new Date(NOW.getTime() - 1)), "subscribed");
  assert.equal(billingState({ subscriptionEndsAt: ends, graceEndsAt: grace }, NOW), "grace");
  assert.equal(billingState({ subscriptionEndsAt: ends, graceEndsAt: grace }, new Date(Date.parse(grace) - 1)), "grace");
  assert.equal(billingState({ subscriptionEndsAt: ends, graceEndsAt: grace }, new Date(grace)), "expired");
});

test("a preview or expired store refuses buyer orders, quotes and domain claims; sign-in, admin and billing stay open", async () => {
  for (const [state, code] of [["preview", "SUBSCRIPTION_REQUIRED"], ["expired", "SUBSCRIPTION_EXPIRED"]] as const) {
    for (const [path, method] of [["/api/submit-order", "POST"], ["/api/submit-middle-order", "POST"], ["/api/record-abandoned-order", "POST"], ["/api/v1/checkout", "POST"], ["/api/shipping-rates", "GET"], ["/api/shipping-options", "POST"], ["/api/admin/domains", "POST"], ["/api/submit-order/", "POST"]]) {
      const refused = subscriptionRefusal(path, method, state);
      assert.equal(refused?.status, 402, `${state} ${method} ${path}`);
      assert.equal((await refused!.json()).code, code);
    }
    for (const [path, method] of [["/", "GET"], ["/produk/x", "GET"], ["/hello", "POST"], ["/admin", "GET"], ["/admin/billing", "GET"], ["/api/admin/billing", "POST"], ["/api/admin/domains", "GET"], ["/api/admin/domains/x.com", "DELETE"], ["/api/admin/products", "POST"]]) {
      assert.equal(subscriptionRefusal(path, method, state), null, `${state} ${method} ${path}`);
    }
  }
  for (const state of ["subscribed", "grace"] as const) {
    assert.equal(subscriptionRefusal("/api/submit-order", "POST", state), null);
    assert.equal(subscriptionRefusal("/api/admin/domains", "POST", state), null);
  }
});

test("an invoice is written before the provider call, uses only the platform key, and stores the QRIS/VA instruction", async () => {
  const { db } = await platform();
  const net = fakeAutoLaris();
  const created = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "12m", channel: "vabca", customer }, NOW, net.fetcher);
  assert.ok(created.ok);
  const invoice = created.ok ? created.value : null!;
  assert.equal(invoice.status, "pending");
  assert.equal(invoice.amount_idr, 1_490_000);
  assert.equal(invoice.total_idr, 1_494_000, "the provider's total is authoritative");
  assert.equal(invoice.virtual_account, "8779611150001393");
  assert.match(invoice.invoice_number, /^ADB-20261120-[A-Z2-9]{8}$/);
  const create = net.calls.find((call) => call.url.endsWith("/create_payment"))!;
  assert.equal(create.auth, "Bearer platform-key");
  assert.equal(create.body!.reff_id, invoice.invoice_number);
  assert.equal(create.body!.amount, "1490000");
  assert.equal(create.body!.expired, autoLarisExpiry(new Date(NOW.getTime() + DAY)));
  assert.equal(create.body!.expired, "20261121100000", "Jakarta time");
  assert.equal(create.body!.callback_url, "https://adsbook.id/api/platform/webhooks/autolaris/hook-token");
  assert.ok(net.calls.every((call) => call.auth === "Bearer platform-key"), "never a tenant key");

  // A new instruction withdraws the old one (it stays checkable for late payment).
  const second = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, net.fetcher);
  assert.ok(second.ok && second.value.qr_payload);
  const statuses = db.sqlite.prepare("SELECT status FROM subscription_invoices WHERE tenant_id = 't-a' ORDER BY created_at, rowid").all().map((row) => (row as { status: string }).status);
  assert.deepEqual(statuses, ["cancelled", "pending"]);
});

test("bad cycle, channel outside QRIS/VA, no platform key, or a provider refusal create nothing payable", async () => {
  const { db } = await platform();
  const net = fakeAutoLaris();
  assert.equal((await createInvoice(db, ENV, { tenantId: "t-a", cycle: "2m", channel: "QRIS", customer }, NOW, net.fetcher)).ok, false);
  for (const channel of ["COD", "OVO", "VAXX"]) {
    const refused = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel, customer }, NOW, net.fetcher);
    assert.equal(refused.ok || refused.status, 422, channel);
  }
  const unconfigured = await createInvoice(db, {}, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, net.fetcher);
  assert.equal(unconfigured.ok || unconfigured.status, 503);
  const previous = console.error;
  console.error = () => undefined;
  try {
    const rejecting = fakeAutoLaris({ create: () => ({ rc: "99", ket: "Ditolak" }) });
    const failed = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, rejecting.fetcher);
    assert.equal(failed.ok || failed.status, 502);
    const wrongAmount = fakeAutoLaris({ create: (body) => ({ rc: "00", data: { trx_id: "x", qr: "q", amount: 1000, admin: 0, total: 1000, ...{ reff: body.reff_id } } }) });
    assert.equal((await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, wrongAmount.fetcher)).ok, false);
  } finally {
    console.error = previous;
  }
  const rows = db.sqlite.prepare("SELECT status, provider_trx_id FROM subscription_invoices").all() as { status: string; provider_trx_id: string | null }[];
  assert.deepEqual(rows.map((row) => row.status), ["cancelled", "cancelled"], "only the two provider failures were written, both cancelled");
});

test("settlement credits once: a replay, a second cron and a concurrent webhook never extend twice", async () => {
  const { db, tenant, events } = await platform();
  const net = fakeAutoLaris();
  const created = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, net.fetcher);
  const id = created.ok ? created.value.id : "";
  const before = tenant().cache_version;
  const [one, two] = await Promise.all([settleInvoice(db, id, "advice", NOW), settleInvoice(db, id, "advice", NOW)]);
  assert.deepEqual([one, two].sort(), ["already-paid", "credited"]);
  assert.equal(await settleInvoice(db, id, "advice", new Date(NOW.getTime() + 60_000)), "already-paid");
  assert.equal(tenant().subscription_ends_at, "2026-12-20T03:00:00.000Z", "now + 30 days");
  assert.equal(tenant().grace_ends_at, "2026-12-22T03:00:00.000Z", "+ 48 hours");
  assert.equal(tenant().cache_version, before + 1);
  assert.equal(events("subscription_paid").length, 1);
  assert.equal(tenant("t-b").subscription_ends_at, null, "another store is untouched");
});

test("early renewal keeps every remaining day; a lapsed store restarts from now", async () => {
  const { db, tenant } = await platform();
  const net = fakeAutoLaris();
  db.sqlite.exec("UPDATE tenants SET subscription_ends_at = '2026-11-30T03:00:00.000Z', grace_ends_at = '2026-12-02T03:00:00.000Z' WHERE id = 't-a'");
  const renewal = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "3m", channel: "QRIS", customer }, NOW, net.fetcher);
  await settleInvoice(db, renewal.ok ? renewal.value.id : "", "advice", NOW);
  assert.equal(tenant().subscription_ends_at, "2027-02-28T03:00:00.000Z", "10 days left + 90");
  assert.equal(tenant().grace_ends_at, "2027-03-02T03:00:00.000Z");
  db.sqlite.exec("UPDATE tenants SET subscription_ends_at = '2026-10-01T00:00:00.000Z', grace_ends_at = '2026-10-03T00:00:00.000Z' WHERE id = 't-b'");
  const lapsed = await createInvoice(db, ENV, { tenantId: "t-b", cycle: "12m", channel: "VABCA", customer }, NOW, net.fetcher);
  await settleInvoice(db, lapsed.ok ? lapsed.value.id : "", "advice", NOW);
  assert.equal(tenant("t-b").subscription_ends_at, "2027-11-20T03:00:00.000Z", "now + 365 days");
});

test("only an explicit Advice settlement credits: PENDING waits, a generic SUCCESS is evidence only", async () => {
  const { db, tenant } = await platform();
  const created = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, fakeAutoLaris().fetcher);
  const invoice = created.ok ? created.value : null!;
  const previous = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(args[0]);
  try {
    assert.equal(await withGlobalFetch(fakeAutoLaris({ advice: { rc: "02", ket: "PENDING" } }).fetcher, () => checkInvoice(db, ENV, invoice, NOW)), "pending");
    assert.equal(await withGlobalFetch(fakeAutoLaris({ advice: { rc: "00", ket: "SUCCESS" } }).fetcher, () => checkInvoice(db, ENV, invoice, NOW)), "unproven");
    assert.equal(tenant().subscription_ends_at, null);
    assert.ok(logged.includes("platform-billing-advice-unproven"));
    const paid = fakeAutoLaris({ advice: { rc: "00", ket: "PAID" } });
    assert.equal(await withGlobalFetch(paid.fetcher, () => checkInvoice(db, ENV, invoice, NOW)), "credited");
    assert.equal(paid.calls[0].body!.transaction_id, invoice.provider_trx_id, "Advice is asked by the provider transaction id");
    assert.equal(paid.calls[0].auth, "Bearer platform-key");
  } finally {
    console.error = previous;
  }
  assert.equal(tenant().subscription_ends_at, "2026-12-20T03:00:00.000Z");
});

test("the cron leg checks open and late instructions, credits a paid one, and expires stale pending ones", async () => {
  const { db, tenant } = await platform();
  const net = fakeAutoLaris();
  const first = await createInvoice(db, ENV, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, net.fetcher);
  // Replaced by a second instruction, but paid late: Advice still finds it.
  await createInvoice(db, ENV, { tenantId: "t-a", cycle: "3m", channel: "QRIS", customer }, NOW, net.fetcher);
  const firstId = first.ok ? first.value.id : "";
  const advice = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const trx = (db.sqlite.prepare("SELECT provider_trx_id FROM subscription_invoices WHERE id = ?").get(firstId) as { provider_trx_id: string }).provider_trx_id;
    return Response.json(body.transaction_id === trx ? { rc: "00", ket: "LUNAS" } : { rc: "02", ket: "PENDING" });
  }) as typeof fetch;
  const later = new Date(NOW.getTime() + 2 * DAY);
  const polled = await withGlobalFetch(advice, () => pollOpenInvoices(db, ENV, later));
  assert.deepEqual(polled, { checked: 2, credited: 1 });
  assert.equal(tenant().subscription_ends_at, "2026-12-22T03:00:00.000Z", "credited from the settlement time");
  const states = Object.fromEntries((db.sqlite.prepare("SELECT cycle_code, status FROM subscription_invoices").all() as { cycle_code: string; status: string }[]).map((row) => [row.cycle_code, row.status]));
  assert.deepEqual(states, { "1m": "paid", "3m": "expired" });
  // Past the late-payment window it is asked once more (it was last asked inside the window), then never again.
  assert.deepEqual(await withGlobalFetch(advice, () => pollOpenInvoices(db, ENV, new Date(NOW.getTime() + 5 * DAY))), { checked: 1, credited: 0 });
  assert.deepEqual(await withGlobalFetch(advice, () => pollOpenInvoices(db, ENV, new Date(NOW.getTime() + 6 * DAY))), { checked: 0, credited: 0 });
});

test("R4 review: a bounded run rotates by last check, so an old backlog never starves a late payment", async () => {
  const { db, tenant } = await platform();
  const net = fakeAutoLaris();
  // Three open instructions on three stores; the run checks one at a time.
  db.sqlite.exec("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t-c', 'toko-c', 'c@example.test', 'active', '2026-11-16')");
  const ids: string[] = [];
  for (const id of ["t-a", "t-b", "t-c"]) {
    const created = await createInvoice(db, ENV, { tenantId: id, cycle: "1m", channel: "QRIS", customer }, NOW, net.fetcher);
    ids.push(created.ok ? created.value.id : "");
  }
  const lastPaid = (db.sqlite.prepare("SELECT provider_trx_id FROM subscription_invoices WHERE id = ?").get(ids[2]) as { provider_trx_id: string }).provider_trx_id;
  const advice = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    Response.json(JSON.parse(String(init?.body)).transaction_id === lastPaid ? { rc: "00", ket: "PAID" } : { rc: "02", ket: "PENDING" })) as typeof fetch;
  for (let minute = 1; minute <= 3; minute += 1) {
    await withGlobalFetch(advice, () => pollOpenInvoices(db, ENV, new Date(NOW.getTime() + minute * 60_000), { limit: 1 }));
  }
  assert.ok(tenant("t-c").subscription_ends_at, "the newest instruction was reached within three bounded runs");
});

test("BILL-7 grant: needs a reason, stacks like a renewal, is audited, and refuses an inactive store", async () => {
  const { db, tenant, events } = await platform();
  assert.equal((await grantSubscription(db, { tenantId: "t-a", days: 30, reason: "", actor: "pu_1" }, NOW)).ok, false);
  assert.equal((await grantSubscription(db, { tenantId: "t-a", days: 0, reason: "pilot Saraku", actor: "pu_1" }, NOW)).ok, false);
  const granted = await grantSubscription(db, { tenantId: "t-a", days: 30, reason: "pilot Saraku", actor: "pu_1" }, NOW);
  assert.ok(granted.ok);
  assert.equal(tenant().subscription_ends_at, "2026-12-20T03:00:00.000Z");
  await grantSubscription(db, { tenantId: "t-a", days: 5, reason: "kompensasi gangguan", actor: "pu_1" }, NOW);
  assert.equal(tenant().subscription_ends_at, "2026-12-25T03:00:00.000Z");
  const audit = events("subscription_granted");
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actor, "pu_1");
  assert.equal(JSON.parse(audit[0].detail_json).reason, "pilot Saraku");
  db.sqlite.exec("UPDATE tenants SET status = 'suspended' WHERE id = 't-b'");
  assert.equal((await grantSubscription(db, { tenantId: "t-b", days: 30, reason: "coba saja", actor: "pu_1" }, NOW)).ok, false);
  assert.equal(events("subscription_granted").length, 2);
});

test("API-9 webhook: a wrong token is a 404; a right one only triggers Advice, and a body claiming payment proves nothing", async () => {
  const { db, tenant } = await platform();
  const env = { ...ENV, PLATFORM_AUTOLARIS_WEBHOOK_TOKEN: "w".repeat(40) };
  const created = await createInvoice(db, env, { tenantId: "t-a", cycle: "1m", channel: "QRIS", customer }, NOW, fakeAutoLaris().fetcher);
  const invoice = created.ok ? created.value : null!;
  const { handleBillingWebhook } = await import("./billing.ts");
  assert.equal((await handleBillingWebhook(db, env, "x".repeat(40), { trx_id: invoice.provider_trx_id, status: "PAID" }, NOW)).status, 404);
  assert.equal((await handleBillingWebhook(db, { ...env, PLATFORM_AUTOLARIS_WEBHOOK_TOKEN: "short" }, "short", {}, NOW)).status, 404, "a short configured token is refused");
  const pending = fakeAutoLaris({ advice: { rc: "02", ket: "PENDING" } });
  const claimed = await withGlobalFetch(pending.fetcher, () => handleBillingWebhook(db, env, "w".repeat(40), { trx_id: invoice.provider_trx_id, status: "PAID", paid: true }, NOW));
  assert.deepEqual(claimed, { status: 200, checked: 1, credited: 0 });
  assert.equal(tenant().subscription_ends_at, null, "the callback body is evidence only");
  const paid = fakeAutoLaris({ advice: { rc: "00", ket: "PAID" } });
  const byReff = await withGlobalFetch(paid.fetcher, () => handleBillingWebhook(db, env, "w".repeat(40), { data: { reff_id: invoice.invoice_number } }, NOW));
  assert.deepEqual(byReff, { status: 200, checked: 1, credited: 1 });
  const replay = await withGlobalFetch(paid.fetcher, () => handleBillingWebhook(db, env, "w".repeat(40), { data: { reff_id: invoice.invoice_number } }, NOW));
  assert.equal(replay.credited, 0, "a replayed callback credits nothing");
  assert.equal(tenant().subscription_ends_at, "2026-12-20T03:00:00.000Z");
});

test("the subscription calendar names stores ending within three days and stores in grace, never the demo", async () => {
  const { db } = await platform();
  db.sqlite.exec(`UPDATE tenants SET subscription_ends_at = '2026-11-22T00:00:00.000Z', grace_ends_at = '2026-11-24T00:00:00.000Z' WHERE id = 't-a';
    UPDATE tenants SET subscription_ends_at = '2026-11-19T12:00:00.000Z', grace_ends_at = '2026-11-21T12:00:00.000Z' WHERE id = 't-b';
    INSERT INTO tenants (id, slug, owner_email, status, is_demo, subscription_ends_at, grace_ends_at, created_at)
      VALUES ('t-demo', 'demo', 'demo@example.test', 'active', 1, '2026-11-21T00:00:00.000Z', '2026-11-23T00:00:00.000Z', '2026-11-16');`);
  const { subscriptionCalendar } = await import("./billing.ts");
  const calendar = await subscriptionCalendar(db, NOW);
  assert.deepEqual(calendar.ending.map((row) => row.slug), ["toko-a"]);
  assert.deepEqual(calendar.grace.map((row) => row.slug), ["toko-b"]);
});
