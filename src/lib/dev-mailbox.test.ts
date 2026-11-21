import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  assertSyntheticRecipient,
  codeFromText,
  loopbackOrigin,
  readVerificationCode,
  sentVerificationIds,
} from "../../scripts/dev-mailbox.ts";

/**
 * The signup suite and `npm run dev:seed` read the verification code from Wrangler's local email capture (Miniflare's
 * Local Explorer). This runs the reader against a loopback stand-in that answers in the shape a real Explorer answered
 * (recorded from wrangler 4.160.0 / miniflare 5.20261110 with the platform's own `send_email` call shape), including its
 * 404 for an unknown id, so a change to the reader that the real shape would not satisfy fails here and not in a browser.
 * It proves the reader, not the product: nothing here touches `src/`.
 */

const SUBJECT = "Kode verifikasi pendaftaran adsbook.id";
const LIST = "/cdn-cgi/local/explorer/api/local/email/sending";
const text = (code: string) =>
  `Kode verifikasi pendaftaran\n\nMasukkan kode ini di halaman pendaftaran adsbook.id untuk memastikan email ini milik Anda:\n\n${code}\n\nKode berlaku 10 menit dan hanya bisa dipakai sekali.`;

type Stored = { messageId: string; to: string[]; subject: string; sentAt: string; text: string };

/** A stand-in Explorer. `mails` is newest first, as the real one lists. */
function explorer(mails: Stored[], options: { listStatus?: number; detailStatus?: number } = {}) {
  const seen: Array<{ path: string; query: string; host: string | undefined }> = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://x");
    seen.push({ path: url.pathname, query: url.search, host: request.headers.host });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname !== LIST) return json(404, { success: false });
    const id = url.searchParams.get("email_id");
    if (id === null) {
      if (options.listStatus) return json(options.listStatus, { success: false });
      return json(200, {
        success: true,
        errors: [],
        messages: [],
        result: mails.map(({ text: _text, ...item }) => ({ worker: "w", from: "noreply@adsbook.id", attachments: [], ...item })),
        result_info: { count: mails.length, per_page: Number(url.searchParams.get("per_page")) || 25, has_more: false },
      });
    }
    if (options.detailStatus) return json(options.detailStatus, { success: false });
    const found = mails.find((mail) => mail.messageId === id);
    if (!found) return json(404, { success: false, errors: [{ code: 10601, message: `Email '${id}' not found.` }], messages: [], result: null });
    const { text: body, ...item } = found;
    return json(200, { success: true, errors: [], messages: [], result: { worker: "w", from: "noreply@adsbook.id", attachments: [], ...item, text: body, html: `<p>${body}</p>` } });
  });
  const listening = new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { server, seen, origin: () => listening };
}

const mail = (id: string, to: string, code: string, at: string, subject = SUBJECT): Stored => ({
  messageId: `<${id}@adsbook.id>`,
  to: [to],
  subject,
  sentAt: at,
  text: text(code),
});

test("a code is read from the newest mail to exactly that recipient that was not there before the request", async (context) => {
  const owner = "owner@toko-satu.local.test";
  const old = mail("old", owner, "11111111", "2026-11-21T08:00:00.000Z");
  const other = mail("other", "lain@toko-dua.local.test", "22222222", "2026-11-21T08:05:00.000Z");
  const e = explorer([other, old]);
  context.after(() => e.server.close());
  const origin = await e.origin();

  const before = await sentVerificationIds(origin, owner);
  assert.deepEqual([...before], ["<old@adsbook.id>"], "only this recipient's verification mails are remembered");

  // A mail for another address and the old mail must never be read; the new one is.
  const fresh = mail("fresh", owner, "33333333", "2026-11-21T08:10:00.000Z");
  const withFresh = explorer([fresh, other, old]);
  context.after(() => withFresh.server.close());
  const code = await readVerificationCode(owner, { explorer: await withFresh.origin(), ignore: before });
  assert.equal(code, "33333333");
  assert.ok(withFresh.seen.some((call) => call.query.includes("email_id=")), "the detail is asked by message id");
});

test("a mail that was already there is never read, even when it is the only one: the reader waits for a NEW mail", async (context) => {
  const owner = "owner@lama.local.test";
  const old = mail("old", owner, "99999999", "2026-11-21T07:00:00.000Z");
  const e = explorer([old]);
  context.after(() => e.server.close());
  const origin = await e.origin();
  const before = await sentVerificationIds(origin, owner);
  assert.deepEqual([...before], ["<old@adsbook.id>"]);
  // Nothing new arrives: the old code must not be returned (it would be a code for an earlier challenge).
  await assert.rejects(
    readVerificationCode(owner, { explorer: origin, ignore: before, timeoutMs: 600, pollMs: 100 }),
    /no new verification mail/,
  );
  assert.equal(e.seen.filter((call) => call.query.includes("email_id=")).length, 0, "the old mail's body was never even fetched");
  // The same mail without the snapshot is returned: the snapshot is what excludes it.
  assert.equal(await readVerificationCode(owner, { explorer: origin, ignore: new Set() }), "99999999");
});

test("a refusal by the guard comes back at once; only a transport error is retried until the deadline", async () => {
  // The explorer address is checked before any request, so the failure comes back at once, not after the timeout.
  const started = Date.now();
  await assert.rejects(readVerificationCode("a@b.test", { explorer: "http://evil.example", ignore: new Set(), timeoutMs: 5_000, pollMs: 100 }), /refusing a non-loopback host/);
  assert.ok(Date.now() - started < 1_000, "a guard refusal does not wait for the deadline");
  await assert.rejects(readVerificationCode("pelanggan@gmail.com", { explorer: "http://127.0.0.1:1", ignore: new Set(), timeoutMs: 5_000, pollMs: 100 }), /not synthetic/);
  assert.ok(Date.now() - started < 1_000, "a recipient refusal does not wait for the deadline either");
  // Nothing listens on this port: that is a transport error, which is retried until the deadline and then reported with its cause.
  const retried = Date.now();
  await assert.rejects(readVerificationCode("a@b.test", { explorer: "http://127.0.0.1:1", ignore: new Set(), timeoutMs: 600, pollMs: 100 }), /no new verification mail for the recipient within 600 ms \(last error: /);
  assert.ok(Date.now() - retried >= 500, "a transport error is retried until the deadline");
});

test("a resend: the newest of several new mails is the one the page now asks for", async (context) => {
  const owner = "owner@resend.local.test";
  const e = explorer([mail("second", owner, "44444444", "2026-11-21T09:02:00.000Z"), mail("first", owner, "55555555", "2026-11-21T09:01:00.000Z")]);
  context.after(() => e.server.close());
  assert.equal(await readVerificationCode(owner, { explorer: await e.origin(), ignore: new Set() }), "44444444");
  // With the first one already seen, only the second counts either way.
  assert.equal(await readVerificationCode(owner, { explorer: await e.origin(), ignore: new Set(["<first@adsbook.id>"]) }), "44444444");
});

test("a mail with another subject, several recipients or no new mail never yields a code", async (context) => {
  const owner = "owner@salah.local.test";
  const e = explorer([
    mail("welcome", owner, "66666666", "2026-11-21T10:00:00.000Z", "Selamat datang di adsbook.id"),
    { ...mail("two", owner, "77777777", "2026-11-21T10:01:00.000Z"), to: [owner, "cc@salah.local.test"] },
  ]);
  context.after(() => e.server.close());
  await assert.rejects(
    readVerificationCode(owner, { explorer: await e.origin(), ignore: new Set(), timeoutMs: 700, pollMs: 100 }),
    /no new verification mail for the recipient within 700 ms/,
  );
});

test("a captured mail with no code line is reported at once as a defect of the mail, not waited out as a missing mail", async (context) => {
  const owner = "owner@rusak.local.test";
  const broken: Stored = { ...mail("rusak", owner, "00000000", "2026-11-21T12:00:00.000Z"), text: "Kode verifikasi pendaftaran\n\n(tidak ada kode di mail ini)" };
  const e = explorer([broken]);
  context.after(() => e.server.close());
  const started = Date.now();
  await assert.rejects(
    readVerificationCode(owner, { explorer: await e.origin(), ignore: new Set(), timeoutMs: 5_000, pollMs: 100 }),
    /expected one 8-digit line in the verification mail, found 0/,
  );
  assert.ok(Date.now() - started < 1_000, "a malformed mail fails at once, not after the 5 s deadline");
});

test("the code is the one 8-digit line of the text; anything else is not a code mail", () => {
  assert.equal(codeFromText(text("12345678")), "12345678");
  assert.throws(() => codeFromText("Tidak ada kode di sini"), /found 0/);
  assert.throws(() => codeFromText(`${text("12345678")}\n\n87654321`), /found 2/);
  assert.throws(() => codeFromText("Kode: 12345678 di tengah kalimat"), /found 0/, "digits inside a sentence are not the code line");
  assert.throws(() => codeFromText(text("1234567")), /found 0/, "seven digits are not a code");
  assert.throws(() => codeFromText(text("123456789")), /found 0/, "nine digits are not a code");
});

test("only plain http on loopback is ever contacted: a network address, https or a lookalike host is refused before any request", async () => {
  for (const refused of [
    "http://100.127.67.86:8807",
    "http://192.168.1.10:8807",
    "http://app.localhost:8807",
    "http://127.0.0.1.evil.example:8807",
    "http://evil.example",
    "https://127.0.0.1:8807",
    "http://[::2]:8807",
    "ftp://127.0.0.1",
    "not a url",
    "",
  ]) {
    assert.throws(() => loopbackOrigin(refused), /\[mailbox\]/, refused || "(empty)");
    await assert.rejects(sentVerificationIds(refused, "a@b.test"), /\[mailbox\]/, `sentVerificationIds ${refused}`);
    await assert.rejects(readVerificationCode("a@b.test", { explorer: refused, ignore: new Set(), timeoutMs: 500 }), /\[mailbox\]/, `readVerificationCode ${refused}`);
  }
  for (const accepted of ["http://127.0.0.1:8807", "http://localhost:8807", "http://[::1]:8807"]) {
    assert.equal(loopbackOrigin(accepted), new URL(accepted).origin, accepted);
  }
});

test("the local mailbox request does not follow a redirect", async (context) => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    response.writeHead(307, { Location: "/outside-explorer" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(sentVerificationIds(origin, "owner@demo.test"), /HTTP 307/);
  assert.deepEqual(seen, [`${LIST}?per_page=100`]);
});

test("only a synthetic recipient is read: a real-looking address is refused before any request", async (context) => {
  for (const refused of ["pelanggan@gmail.com", "owner@toko.id", "owner@adsbook.id", "owner@example.com", "owner@test.com", "bukan-email", "owner@", "@x.test", ""]) {
    assert.throws(() => assertSyntheticRecipient(refused), /\[mailbox\]/, refused || "(empty)");
  }
  for (const accepted of ["owner@toko.local.test", "OWNER@Signup-Smoke.Example.Test", "a@b.example", "a@mail.invalid", "a@x.localhost", "a@test"]) {
    assert.doesNotThrow(() => assertSyntheticRecipient(accepted), accepted);
  }
  const e = explorer([]);
  context.after(() => e.server.close());
  const origin = await e.origin();
  await assert.rejects(sentVerificationIds(origin, "pelanggan@gmail.com"), /not synthetic/);
  await assert.rejects(readVerificationCode("pelanggan@gmail.com", { explorer: origin, ignore: new Set() }), /not synthetic/);
  assert.equal(e.seen.length, 0, "no request was made for a refused recipient");
});

test("a capture that is not there (Explorer off, wrong port) is an error that says so; a server that answers late is waited for", async (context) => {
  const down = explorer([], { listStatus: 404 });
  context.after(() => down.server.close());
  await assert.rejects(sentVerificationIds(await down.origin(), "a@b.test"), /HTTP 404 \(is the dev server running on this port, and X_LOCAL_EXPLORER not disabled\?\)/);

  // The mail shows up only on the third poll: the reader keeps asking until it does.
  const owner = "owner@lambat.local.test";
  let calls = 0;
  const late = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    response.writeHead(200, { "Content-Type": "application/json" });
    if (url.searchParams.get("email_id")) return void response.end(JSON.stringify({ success: true, result: { text: text("88888888") } }));
    calls += 1;
    response.end(JSON.stringify({ success: true, result: calls < 3 ? [] : [{ messageId: "<late@adsbook.id>", to: [owner], subject: SUBJECT, sentAt: "2026-11-21T11:00:00.000Z" }] }));
  });
  await new Promise<void>((resolve) => late.listen(0, "127.0.0.1", resolve));
  context.after(() => late.close());
  const origin = `http://127.0.0.1:${(late.address() as AddressInfo).port}`;
  assert.equal(await readVerificationCode(owner, { explorer: origin, ignore: new Set(), pollMs: 50, timeoutMs: 5_000 }), "88888888");
  assert.ok(calls >= 3);
});
