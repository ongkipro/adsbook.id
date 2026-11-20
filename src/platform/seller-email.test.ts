// Seller signup confirmation: at most one logical mail per tenant, fake transport only.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import {
  emailTransportFromEnv,
  sellerSignupMessage,
  sendSellerSignupEmail,
  SELLER_EMAIL_FROM,
  SELLER_SIGNIN_URL,
  type SellerEmailMessage,
} from "./seller-email.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
const TENANT = { tenantId: "t-a", email: "owner@toko-a.example", storeName: "Toko <A> & Co" };

async function setup() {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  const sent: SellerEmailMessage[] = [];
  const accept = async (message: SellerEmailMessage) => (sent.push(message), { messageId: "fake-1" });
  const claims = () => db.sqlite.prepare("SELECT notice FROM operator_notices WHERE tenant_id = 't-a'").all().map((row) => (row as { notice: string }).notice);
  return { db, sent, accept, claims };
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  console.warn = console.error = () => undefined;
  try {
    return await run();
  } finally {
    Object.assign(console, { warn, error });
  }
}

test("the message is Indonesian, names the store, carries one fixed sign-in URL and no secret or token", () => {
  const message = sellerSignupMessage("owner@toko-a.example", "Toko <A> & Co\r\nBcc: x@evil.example");
  assert.equal(message.from, SELLER_EMAIL_FROM);
  assert.equal(message.to, "owner@toko-a.example");
  assert.equal(message.subject, "Toko Anda sudah terdaftar di adsbook.id");
  assert.match(message.text, /sudah terdaftar di adsbook\.id/);
  assert.ok(message.text.includes(SELLER_SIGNIN_URL) && message.html.includes(SELLER_SIGNIN_URL));
  assert.ok(message.html.includes("Toko &lt;A&gt; &amp; Co"), "the store name is escaped in HTML");
  assert.doesNotMatch(message.subject + message.text, /[\r\n]Bcc:/i, "no header injection through the store name");
  assert.equal([...(message.text + message.html).matchAll(/https?:\/\/[^\s"<]+/g)].every(([url]) => url.startsWith("https://adsbook.id/masuk")), true, "only the fixed URL, no query or token");
  assert.doesNotMatch(message.text + message.html, /password=|token|kata sandi:\s*\S{6,}|magic/i);
});

test("a successful signup yields exactly one logical mail: the second dispatch is a duplicate and sends nothing", async () => {
  const { db, sent, accept, claims } = await setup();
  assert.equal(await sendSellerSignupEmail({}, db, TENANT, accept), "submitted");
  assert.equal(await sendSellerSignupEmail({}, db, TENANT, accept), "duplicate");
  assert.equal(await Promise.all([sendSellerSignupEmail({}, db, { ...TENANT, tenantId: "t-b" }, accept), sendSellerSignupEmail({}, db, { ...TENANT, tenantId: "t-b" }, accept)]).then((r) => r.sort().join()), "duplicate,submitted", "concurrent dispatch still sends once");
  assert.equal(sent.length, 2, "one for t-a, one for t-b");
  assert.deepEqual(claims(), ["seller_signup_email"]);
});

test("no transport: nothing is sent or claimed, it is observable, and enabling the binding later still works", async () => {
  const { db, sent, accept, claims } = await setup();
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    assert.equal(await sendSellerSignupEmail({}, db, TENANT), "skipped");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, [["seller-email-transport-missing", { tenant_id: "t-a" }]], "tenant id only");
  assert.deepEqual(claims(), []);
  assert.equal(await sendSellerSignupEmail({}, db, TENANT, accept), "submitted");
  assert.equal(sent.length, 1);
  assert.equal(emailTransportFromEnv({}), null);
  assert.equal(emailTransportFromEnv({ EMAIL: {} }), null);
  assert.equal(typeof emailTransportFromEnv({ EMAIL: { send: async () => ({ messageId: "x" }) } }), "function");
});

test("a refusal with a provider code is a definite failure, anything else unknown; neither throws, neither is replayed, no recipient is logged", async () => {
  const { db, claims } = await setup();
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(JSON.stringify(args));
  try {
    const refused = async () => { throw Object.assign(new Error("sender owner@toko-a.example not verified"), { code: "E_SENDER_NOT_VERIFIED" }); };
    assert.equal(await sendSellerSignupEmail({}, db, TENANT, refused), "failed");
    const lost = async () => { throw new Error("Network connection lost owner@toko-b.example"); };
    assert.equal(await sendSellerSignupEmail({}, db, { ...TENANT, tenantId: "t-b" }, lost), "unknown");
    const malformed = async () => { throw new TypeError("bad message"); };
    assert.equal(await sendSellerSignupEmail({}, db, { ...TENANT, tenantId: "t-c" }, malformed), "failed");
  } finally {
    console.error = error;
  }
  assert.deepEqual(claims(), ["seller_signup_email"], "the claim is kept: an ambiguous send is never replayed");
  assert.equal(await sendSellerSignupEmail({}, db, TENANT, async () => ({})), "duplicate");
  assert.ok(logged.some((line) => line.includes("E_SENDER_NOT_VERIFIED")));
  assert.doesNotMatch(logged.join(), /@toko-|Toko/, "neither the recipient nor the store name reaches the log");
});

test("only a Cloudflare E_ code or a malformed-argument TypeError is a definite failure; a network string code is unknown and no free text reaches the log", async () => {
  const { db } = await setup();
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void logged.push(JSON.stringify(args));
  try {
    const outcome = (id: string, thrown: unknown) => sendSellerSignupEmail({}, db, { ...TENANT, tenantId: id }, async () => { throw thrown; });
    assert.equal(await outcome("t-1", Object.assign(new Error("x"), { code: "E_EMAIL_SENDING_NOT_READY" })), "failed");
    assert.equal(await outcome("t-2", Object.assign(new Error("x"), { code: "E_DELIVERY_FAILED" })), "failed");
    assert.equal(await outcome("t-3", Object.assign(new Error("x"), { code: "ECONNRESET" })), "unknown", "a network code does not say whether the mail left");
    assert.equal(await outcome("t-4", Object.assign(new Error("x"), { code: "owner@toko-a.example rejected" })), "unknown");
    assert.equal(await outcome("t-5", Object.assign(new Error("x"), { code: "E_" + "A".repeat(80) })), "unknown", "an over-long code is not a provider code");
  } finally {
    console.error = error;
  }
  const text = logged.join("\n");
  assert.match(text, /E_EMAIL_SENDING_NOT_READY/);
  assert.doesNotMatch(text, /ECONNRESET|owner@|rejected|AAAA/, "unrecognised codes are dropped from the log");
});

test("a claim that cannot be written sends nothing and does not throw", async () => {
  const { db, sent, accept } = await setup();
  const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
  assert.equal(await quiet(() => sendSellerSignupEmail({}, broken, TENANT, accept)), "unknown");
  assert.equal(sent.length, 0);
  void db;
});
