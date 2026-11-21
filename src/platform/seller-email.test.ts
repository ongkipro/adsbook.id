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

const BUTTON = "Masuk ke Panel Toko";
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg: string, bg: string) => (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
const decode = (value: string) => value.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Visible text of the mail HTML: tags dropped, the hidden preheader and the title removed, entities decoded. */
const visibleText = (html: string) =>
  decode(html.replace(/<title>[\s\S]*?<\/title>/, "").replace(/<div style="display:none[\s\S]*?<\/div>/, "").replace(/<\/?(?:span|strong)[^>]*>/g, "").replace(/<br>/g, "\n").replace(/<[^>]+>/g, "\n"))
    .split("\n").map((line) => line.trim()).filter(Boolean);

test("the message is Indonesian, names the store, has one button to the fixed sign-in URL and no secret, token or tracker", () => {
  const message = sellerSignupMessage("owner@toko-a.example", "Toko <A> & Co\r\nBcc: x@evil.example");
  assert.equal(message.from, SELLER_EMAIL_FROM);
  assert.equal(message.to, "owner@toko-a.example");
  assert.equal(message.subject, "Toko Anda sudah terdaftar di adsbook.id");
  assert.doesNotMatch(message.subject, /[\r\n]/);
  assert.match(message.text, /Toko Anda sudah terdaftar/);
  assert.match(message.text, /sudah dibuat di adsbook\.id/);
  assert.ok(message.html.includes("Toko &lt;A&gt; &amp; Co"), "the store name is escaped in HTML");
  assert.doesNotMatch(message.subject + message.text, /[\r\n]Bcc:/i, "no header injection through the store name");
  // The sign-in URL is the only URL anywhere, in both bodies.
  for (const body of [message.text, message.html]) {
    assert.deepEqual([...body.matchAll(/https?:\/\/[^\s"<]+/g)].map(([url]) => url).filter((url, i, all) => all.indexOf(url) === i), [SELLER_SIGNIN_URL]);
  }
  assert.doesNotMatch(message.text + message.html, /password|token|magic|kata sandi:\s*\S/i);
});

test("the HTML has exactly one link, the button, whose label and target match the plain text", () => {
  const { html, text } = sellerSignupMessage("owner@toko-a.example", "Toko A");
  const anchors = [...html.matchAll(/<a\s[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(anchors.length, 1, "one button, no second link");
  assert.equal(anchors[0][1], BUTTON);
  assert.match(anchors[0][0], new RegExp(`href="${SELLER_SIGNIN_URL.replace(/[.]/g, "\\.")}"`));
  assert.equal([...html.matchAll(/href=/g)].length, 1);
  assert.ok(text.includes(`${BUTTON}: ${SELLER_SIGNIN_URL}`), "plain-text URL parity");
  assert.ok(html.includes(`Salin alamat ini ke browser: ${SELLER_SIGNIN_URL}`), "the URL is also visible as text when the button fails");
});

test("plain text and HTML say the same thing: every plain-text line appears in the visible HTML text", () => {
  const { html, text } = sellerSignupMessage("owner@toko-a.example", "Toko Sambal Mak Ijah");
  const seen = visibleText(html).join("\n");
  for (const line of text.split("\n").filter(Boolean)) {
    const needle = line.replace(`${BUTTON}: ${SELLER_SIGNIN_URL}`, BUTTON).replace(/^Halo, toko "(.*)" /, "Halo, toko $1 ");
    assert.ok(seen.includes(needle), `missing from HTML: ${line}`);
  }
});

test("hostile store names stay text: no markup, script, attribute break-out or extra link reaches the HTML or the subject", () => {
  for (const name of ['<script>alert(1)</script>', '"><a href="https://evil.example">x</a>', "' onmouseover='x", "&lt;b&gt; &amp;", "Toko\u2028Baru\r\nSubject: x", "A".repeat(500), "   ", ""]) {
    const { html, subject, text } = sellerSignupMessage("owner@toko-a.example", name);
    assert.doesNotMatch(html, /<script|<b>|<a href="https:\/\/evil|<[^>]*\sonmouseover=/i, name);
    assert.equal([...html.matchAll(/<a\s/g)].length, 1, "still exactly one link");
    assert.doesNotMatch(subject, /[\r\n]/);
    assert.doesNotMatch(text, /\r|\u2028|\u2029|^Subject:/m, "no header-looking line or Unicode line break from the name");
  }
  assert.match(sellerSignupMessage("a@b.example", "   ").text, /toko "toko Anda"|toko "toko Anda"/);
  assert.ok(sellerSignupMessage("a@b.example", "A".repeat(500)).html.includes("A".repeat(80)) && !sellerSignupMessage("a@b.example", "A".repeat(500)).html.includes("A".repeat(81)), "the name is cut at 80");
});

test("no tracking surface: no image, remote resource, style import, script, form or query on any URL", () => {
  const { html } = sellerSignupMessage("owner@toko-a.example", "Toko A");
  assert.doesNotMatch(html, /<img|<link|<script|<form|<iframe|<video|<audio|<object|<embed|src=|srcset|url\(|@import|background-image|xmlns|<svg/i);
  assert.doesNotMatch(html, /https?:\/\/[^\s"<]*[?#=]/, "no query, fragment or id on a URL");
});

test("brand and layout: white canvas, blue button with readable contrast, fluid width, text wordmark that survives blocked images", () => {
  const { html } = sellerSignupMessage("owner@toko-a.example", "Toko A");
  assert.match(html, /<html lang="id">/);
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /<body style="margin:0;padding:0;background:#ffffff;">/);
  assert.match(html, /max-width:520px;width:100%/, "fluid below 520 px, no fixed width that forces horizontal scroll");
  assert.match(html, /overflow-wrap:anywhere;word-wrap:break-word;word-break:break-word/, "an 80-character store name with no spaces wraps instead of forcing horizontal scroll");
  assert.doesNotMatch(html, /width="(?:[6-9]\d\d|\d{4,})"|min-width:\s*[5-9]\d\d/, "no wide fixed table");
  assert.match(html, /bgcolor="#2563eb"[^>]*style="background:#2563eb;/, "the button keeps its colour where CSS background is dropped");
  assert.ok(html.includes('adsbook<span style="color:#2563eb;">.</span>id'), "official wordmark as text: slate letters, blue dot");
  assert.ok(contrast("#ffffff", "#2563eb") >= 4.5, "button text on brand blue");
  assert.ok(contrast("#0f172a", "#ffffff") >= 7 && contrast("#475569", "#ffffff") >= 4.5, "ink and muted text on white");
  assert.ok(visibleText(html)[0] === "adsbook.id", "the wordmark reads as text first, with no image");
});

test("the copy confirms creation and the next step, and does not claim verification, readiness to sell or a support reply", () => {
  const { html, text } = sellerSignupMessage("owner@toko-a.example", "Toko A");
  for (const body of [text, visibleText(html).join("\n")]) {
    assert.match(body, /sudah dibuat di adsbook\.id/);
    assert.match(body, /Langkah berikutnya: masuk ke panel toko/);
    assert.doesNotMatch(body, /terverifikasi|diverifikasi|verifikasi|dikonfirmasi|siap (?:jual|berjualan|menerima)|mulai berjualan|hubungi|balas (?:email|pesan)|support|hello@|bantuan/i);
    assert.match(body, /tidak menerima balasan/);
    assert.doesNotMatch(body, /\b(?:beli|belanja|promo|diskon)\b/i, "no sales language in a service mail");
  }
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
