/**
 * T-58 / PR-11: the mandatory mailbox gate, end to end on the real control
 * plane chain (createSqliteD1), including the signup challenge migration, with the real
 * `signup()` and a fake in-memory mailbox. The tenant store is a stub that
 * records whether provisioning was ever reached: every refusal here must
 * leave no tenant, no host, no identity, no store and no handoff.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createSqliteD1, type SqliteD1 } from "./testing/sqlite-d1.ts";

const platformDir = new URL("./migrations/", import.meta.url);
const PLATFORM_CHAIN = readdirSync(platformDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(new URL(name, platformDir), "utf8") }));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./bundled-migrations.ts" && /src\/platform\//.test(context.parentURL ?? "")) return { url: "stub:platform-chain", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "stub:platform-chain") return { format: "module", source: `export const PLATFORM_MIGRATIONS = ${JSON.stringify(PLATFORM_CHAIN)};`, shortCircuit: true };
    return nextLoad(url, context);
  },
});
void hooks;

const { ensureControlPlane } = await import("./control-plane.ts");
const { signup, requestSignupEmailCode } = await import("./signup.ts");
const {
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_SENDS_PER_HOUR,
  SIGNUP_CODE_TTL_MS,
  newEmailCode,
  newChallengeId,
  signupCodeMessage,
  verificationKey,
  codeDigest,
} = await import("./signup-verification.ts");

const SECRET = "platform-auth-secret-for-tests-0123456789";
const T0 = Date.parse("2026-11-20T10:00:00.000Z");

type Mail = { to: string; subject: string; text: string; html: string };

async function harness() {
  const db: SqliteD1 = createSqliteD1();
  await ensureControlPlane(db, PLATFORM_CHAIN);
  const mails: Mail[] = [];
  let transportFails = false;
  const transport = async (message: Mail) => {
    if (transportFails) throw Object.assign(new Error("down"), { code: "E_INTERNAL_SERVER_ERROR" });
    mails.push(message);
    return { messageId: "memory" };
  };
  // A store namespace that only records being asked: reaching it means a tenant was reserved.
  const opened: string[] = [];
  const env: Record<string, unknown> = {
    PLATFORM_DB: db,
    PLATFORM_AUTH_SECRET: SECRET,
    TENANT_STORE: { getByName(id: string) { opened.push(id); throw new Error("store reached in a gate test"); } },
  };
  let clock = T0;
  const now = () => new Date(clock);
  const deps = { now, verifyTurnstile: async () => true, emailTransport: transport };
  const requestCode = (email: string, over: Record<string, unknown> = {}) =>
    requestSignupEmailCode(env, { email, turnstileToken: "ok" }, "198.51.100.1", { ...deps, ...over });
  const codeOf = (email: string) => mails.filter((mail) => mail.to === email).at(-1)?.text.match(/^(\d{8})$/m)?.[1];
  // Each final post from its own address: the existing signup limit (5/hour/IP) is not what these tests measure.
  let ip = 0;
  const finish = (email: string, challengeId: unknown, emailCode: unknown, slug = "toko-gate", over: Record<string, unknown> = {}) =>
    signup(env, { storeName: "Toko Gate", slug, email, password: "kata-sandi-panjang-1", terms: true, turnstileToken: "ok", challengeId, emailCode }, `203.0.113.${(ip += 1)}`, { ...deps, ...over });
  const count = (table: string) => Number((db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const nothingReserved = () => {
    assert.equal(count("tenants"), 0, "no tenant");
    assert.equal(count("tenant_hosts"), 0, "no host");
    assert.equal(count("platform_identities"), 0, "no identity");
    assert.equal(count("handoff_tokens"), 0, "no handoff");
    assert.deepEqual(opened, [], "no store opened");
  };
  const challenge = () => db.sqlite.prepare("SELECT state, attempts FROM signup_email_challenges ORDER BY created_at DESC LIMIT 1").get() as { state: string; attempts: number };
  return {
    db, env, mails, opened, deps, requestCode, codeOf, finish, count, nothingReserved, challenge,
    advance: (ms: number) => void (clock += ms),
    setTransportFails: (value: boolean) => void (transportFails = value),
  };
}

const quiet = async (run: () => Promise<void>) => {
  const original = { error: console.error, warn: console.warn };
  console.error = console.warn = () => undefined;
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
};

test("a code request mails 8 digits to the exact address and stores only digests", async () => {
  const h = await harness();
  const result = await h.requestCode("  Pemilik@Contoh.Example ");
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.match(result.challengeId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, "pemilik@contoh.example", "the normalized address");
  const code = h.codeOf("pemilik@contoh.example")!;
  assert.match(code, /^\d{8}$/);
  assert.doesNotMatch(h.mails[0].subject, /\d{8}/, "never in the subject (previews)");
  assert.doesNotMatch(h.mails[0].html, /<a\s|<img\s|https?:\/\//i, "no link, image or tracking");
  const row = h.db.sqlite.prepare("SELECT * FROM signup_email_challenges").get() as Record<string, unknown>;
  const stored = JSON.stringify(row);
  for (const secret of [code, result.challengeId, "pemilik@contoh.example", "contoh"]) assert.ok(!stored.includes(secret), `not stored: ${secret}`);
  assert.deepEqual([row.state, row.attempts, Number(row.expires_at) - Number(row.created_at)], ["sent", 0, SIGNUP_CODE_TTL_MS]);
  h.nothingReserved();
});

test("missing, malformed or wrong proofs never reach Turnstile, the reservation or the store", async () => {
  const h = await harness();
  const issued = await h.requestCode("a@contoh.example");
  assert.equal(issued.status, 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("a@contoh.example")!;
  let turnstileCalls = 0;
  const counting = { verifyTurnstile: async () => ((turnstileCalls += 1), true) };
  for (const [id, value] of [
    [undefined, undefined],
    [issued.challengeId, undefined],
    [undefined, code],
    [issued.challengeId, "1234567"],
    [issued.challengeId, "123456789"],
    [issued.challengeId, "١٢٣٤٥٦٧٨"],
    [issued.challengeId, 12345678],
    ["short", code],
    [`${issued.challengeId}=`, code],
  ] as const) {
    const refused = await h.finish("a@contoh.example", id, value, "toko-gate", counting);
    assert.equal(refused.status, 400, JSON.stringify([id, value]));
    if (refused.status === 400) assert.ok(refused.errors?.emailCode);
  }
  assert.equal(turnstileCalls, 0, "a malformed proof is refused before any outside call");
  assert.equal(h.challenge().attempts, 0, "and spends no attempt");
  h.nothingReserved();
});

test("a wrong code or an unknown challenge reserves nothing; the right one afterwards still works", async () => {
  const h = await harness();
  const issued = await h.requestCode("b@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("b@contoh.example")!;
  const wrong = code === "00000000" ? "00000001" : "00000000";
  await quiet(async () => {
    assert.equal((await h.finish("b@contoh.example", issued.challengeId, wrong)).status, 400);
    assert.equal((await h.finish("b@contoh.example", newChallengeId(), code)).status, 400, "an unknown challenge id");
  });
  assert.deepEqual({ ...h.challenge() }, { state: "sent", attempts: 1 }, "the wrong code spent one attempt; the unknown id none");
  h.nothingReserved();
});

test("the code is bound to the exact address: another address with the same id and code is refused", async () => {
  const h = await harness();
  const issued = await h.requestCode("c@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("c@contoh.example")!;
  for (const other of ["c2@contoh.example", "c@contoh.example.evil", "C@contoh.example "]) {
    const result = await h.finish(other, issued.challengeId, code);
    if (other === "C@contoh.example ") {
      // Normalization is the binding: the same mailbox in another case is the same address.
      assert.equal(result.status, 500, "same normalized address: claim wins, then the stub store refuses");
      continue;
    }
    assert.equal(result.status, 400, other);
    // Another address must not even burn the owner's attempts (the claim matches no row).
    assert.equal(h.challenge().attempts, 0, `${other}: no attempt spent`);
  }
  assert.equal(Number(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenants WHERE owner_email <> 'c@contoh.example'").get()!.n), 0);
});

test("an expired code is refused at the reservation, and spends nothing", async () => {
  const h = await harness();
  const issued = await h.requestCode("d@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("d@contoh.example")!;
  h.advance(SIGNUP_CODE_TTL_MS);
  assert.equal((await h.finish("d@contoh.example", issued.challengeId, code)).status, 400);
  assert.equal(h.challenge().attempts, 0);
  h.nothingReserved();
});

test("attempts are capped: after the last wrong code even the right one is refused", async () => {
  const h = await harness();
  const issued = await h.requestCode("e@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("e@contoh.example")!;
  const wrong = code === "11111111" ? "22222222" : "11111111";
  for (let attempt = 0; attempt < SIGNUP_CODE_MAX_ATTEMPTS; attempt += 1) {
    assert.equal((await h.finish("e@contoh.example", issued.challengeId, wrong)).status, 400);
  }
  assert.deepEqual({ ...h.challenge() }, { state: "exhausted", attempts: SIGNUP_CODE_MAX_ATTEMPTS });
  assert.equal((await h.finish("e@contoh.example", issued.challengeId, code)).status, 400);
  h.nothingReserved();
});

test("a newer code supersedes the older one; resends are gapped and capped per address", async () => {
  const h = await harness();
  const first = await h.requestCode("f@contoh.example");
  assert.ok(first.status === 200);
  if (first.status !== 200) return;
  const firstCode = h.codeOf("f@contoh.example")!;
  assert.equal((await h.requestCode("f@contoh.example")).status, 429, "inside the resend gap");
  assert.equal(h.mails.length, 1, "no mail for a refused request");
  h.advance(61_000);
  const second = await h.requestCode("f@contoh.example");
  assert.equal(second.status, 200);
  assert.equal((await h.finish("f@contoh.example", first.challengeId, firstCode)).status, 400, "the superseded code");
  for (let sent = 2; sent < SIGNUP_CODE_SENDS_PER_HOUR; sent += 1) {
    h.advance(61_000);
    assert.equal((await h.requestCode("f@contoh.example")).status, 200);
  }
  h.advance(61_000);
  assert.equal((await h.requestCode("f@contoh.example")).status, 429, "the hourly cap per address");
  assert.equal(h.mails.length, SIGNUP_CODE_SENDS_PER_HOUR);
  h.advance(60 * 60 * 1000);
  assert.equal((await h.requestCode("f@contoh.example")).status, 200, "the cap is a sliding hour");
  h.nothingReserved();
});

test("a failed send answers 503, leaves the challenge unclaimable, and still counts toward the cap", async () => {
  const h = await harness();
  h.setTransportFails(true);
  let failed: Awaited<ReturnType<typeof h.requestCode>> | undefined;
  await quiet(async () => {
    failed = await h.requestCode("g@contoh.example");
  });
  assert.equal(failed?.status, 503);
  assert.equal(h.challenge().state, "void");
  // Even a correct code for that row could not be claimed (forge it with the real key).
  const row = h.db.sqlite.prepare("SELECT challenge_id_hash FROM signup_email_challenges").get() as { challenge_id_hash: string };
  assert.ok(row.challenge_id_hash);
  h.setTransportFails(false);
  h.advance(61_000);
  for (let sent = 1; sent < SIGNUP_CODE_SENDS_PER_HOUR; sent += 1) {
    assert.equal((await h.requestCode("g@contoh.example")).status, 200);
    h.advance(61_000);
  }
  assert.equal((await h.requestCode("g@contoh.example")).status, 429, "the failed send was counted");
  h.nothingReserved();
});

test("no transport, no key, a short key or no table: no code and no signup (fail closed, no bypass)", async () => {
  const h = await harness();
  assert.equal((await h.requestCode("h@contoh.example", { emailTransport: null })).status, 503);
  const noKey = { ...h.env, PLATFORM_AUTH_SECRET: undefined };
  assert.equal((await requestSignupEmailCode(noKey, { email: "h@contoh.example", turnstileToken: "ok" }, "198.51.100.1", h.deps)).status, 503);
  const shortKey = { ...h.env, PLATFORM_AUTH_SECRET: "too-short" };
  assert.equal((await requestSignupEmailCode(shortKey, { email: "h@contoh.example", turnstileToken: "ok" }, "198.51.100.1", h.deps)).status, 503);
  const final = (env: Record<string, unknown>) =>
    signup(env, { storeName: "Toko", slug: "toko-kunci", email: "h@contoh.example", password: "kata-sandi-panjang-1", terms: true, turnstileToken: "ok", challengeId: newChallengeId(), emailCode: "12345678" }, "198.51.100.2", h.deps);
  assert.equal((await final(noKey)).status, 503);
  assert.equal((await final(shortKey)).status, 503);
  assert.equal(h.mails.length, 0);

  // Simulate unavailable challenge storage after the ledger was applied.
  const bare = createSqliteD1();
  await ensureControlPlane(bare, PLATFORM_CHAIN);
  bare.sqlite.exec("DROP TABLE signup_email_challenges");
  const bareEnv = { ...h.env, PLATFORM_DB: bare };
  await quiet(async () => {
    assert.equal((await requestSignupEmailCode(bareEnv, { email: "h@contoh.example", turnstileToken: "ok" }, "198.51.100.3", h.deps)).status, 500);
    assert.equal((await final(bareEnv)).status, 500);
  });
  assert.equal(Number((bare.sqlite.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n), 0);
  assert.equal(h.mails.length, 0, "no mail without a stored challenge");
  h.nothingReserved();
});

test("a failed Turnstile or a taken email gets no code; the code request has its own per-network limit", async () => {
  const h = await harness();
  assert.equal((await h.requestCode("i@contoh.example", { verifyTurnstile: async () => false })).status, 400);
  h.db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t_x', 'x-ada', 'taken@contoh.example', 'active', '2026-11-20')").run();
  assert.equal((await h.requestCode("taken@contoh.example")).status, 409);
  assert.equal((await h.requestCode("bukan-email")).status, 400);
  assert.equal(h.mails.length, 0);
  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1) statuses.push((await h.requestCode(`flood${index}@contoh.example`)).status);
  assert.equal(statuses.at(-1), 429, "the eleventh code request from one network in an hour");
});

test("a DB failure in the reservation batch rolls the consumption back: nothing reserved, the code still usable", async () => {
  const h = await harness();
  const issued = await h.requestCode("j@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("j@contoh.example")!;
  h.db.failWhen = /INSERT INTO platform_identities/;
  await quiet(async () => {
    assert.equal((await h.finish("j@contoh.example", issued.challengeId, code)).status, 500);
  });
  h.db.failWhen = null;
  assert.deepEqual({ ...h.challenge() }, { state: "sent", attempts: 0 }, "the claim rolled back with the batch");
  h.nothingReserved();
});

test("a taken slug rolls the consumption back too; the same code then reserves another slug once", async () => {
  const h = await harness();
  h.db.sqlite.prepare("INSERT INTO tenants (id, slug, owner_email, status, created_at) VALUES ('t_y', 'sudah-ada', 'lain@contoh.example', 'active', '2026-11-20')").run();
  const issued = await h.requestCode("k@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("k@contoh.example")!;
  const taken = await h.finish("k@contoh.example", issued.challengeId, code, "sudah-ada");
  assert.equal(taken.status, 409);
  assert.deepEqual({ ...h.challenge() }, { state: "sent", attempts: 0 });
  await quiet(async () => {
    // Reserved, then the stub store refuses: provisioning reached exactly once.
    assert.equal((await h.finish("k@contoh.example", issued.challengeId, code, "slug-lain")).status, 500);
  });
  assert.equal(h.opened.length, 1);
  assert.equal(h.challenge().state, "consumed");
});

test("a consumed code is single use: a replay reserves nothing, even after the first store was purged", async () => {
  const h = await harness();
  const issued = await h.requestCode("l@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("l@contoh.example")!;
  await quiet(async () => {
    assert.equal((await h.finish("l@contoh.example", issued.challengeId, code, "pertama")).status, 500, "reserved, then provisioning failed");
  });
  assert.equal(h.opened.length, 1);
  // The failed tenant released its email: only the spent code stands in the way.
  assert.equal(Number(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM platform_identities").get()!.n), 0);
  assert.equal((await h.finish("l@contoh.example", issued.challengeId, code, "kedua")).status, 400, "replay");
  assert.equal(h.opened.length, 1, "no second provisioning");
  assert.equal(Number(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenants WHERE slug = 'kedua'").get()!.n), 0);
});

test("concurrent claims of one code: exactly one reserves", async () => {
  const h = await harness();
  const issued = await h.requestCode("m@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("m@contoh.example")!;
  let results: Array<Awaited<ReturnType<typeof h.finish>>> = [];
  await quiet(async () => {
    results = await Promise.all(Array.from({ length: 5 }, (_, index) => h.finish("m@contoh.example", issued.challengeId, code, `balap-${index}`)));
  });
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [400, 400, 400, 400, 500], "one winner (then the stub store), four refusals");
  assert.equal(h.opened.length, 1);
  assert.equal(Number(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM tenants").get()!.n), 1);
});

test("the digests are keyed and domain separated; the code generator is 8 uniform ASCII digits", async () => {
  const key = (await verificationKey({ PLATFORM_AUTH_SECRET: SECRET }))!;
  const other = (await verificationKey({ PLATFORM_AUTH_SECRET: `${SECRET}x` }))!;
  const id = newChallengeId();
  const a = await codeDigest(key, id, "a@contoh.example", "12345678");
  assert.notEqual(a, await codeDigest(other, id, "a@contoh.example", "12345678"), "another secret, another digest");
  assert.notEqual(a, await codeDigest(key, newChallengeId(), "a@contoh.example", "12345678"), "bound to the challenge id");
  assert.notEqual(a, await codeDigest(key, id, "b@contoh.example", "12345678"), "bound to the address");
  assert.equal(await verificationKey({ PLATFORM_AUTH_SECRET: "x".repeat(31) }), null);
  const seen = new Set<string>();
  for (let index = 0; index < 2000; index += 1) {
    const code = newEmailCode();
    assert.match(code, /^[0-9]{8}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 1990, "no visible repetition");
  const message = signupCodeMessage("a@contoh.example", "01234567");
  assert.match(message.text, /^01234567$/m);
  assert.match(message.html, /01234567/);
});

test("no plaintext code, address or challenge id is logged on any path", async () => {
  const h = await harness();
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  console.error = console.warn = console.log = console.info = (...args: unknown[]) => void lines.push(JSON.stringify(args));
  let issued: Awaited<ReturnType<typeof h.requestCode>> | undefined;
  try {
    issued = await h.requestCode("n@contoh.example");
    h.setTransportFails(true);
    h.advance(61_000);
    await h.requestCode("n@contoh.example");
    h.setTransportFails(false);
    if (issued.status === 200) {
      await h.finish("n@contoh.example", issued.challengeId, "00000000");
      await h.finish("n@contoh.example", issued.challengeId, h.codeOf("n@contoh.example"));
    }
  } finally {
    Object.assign(console, original);
  }
  assert.ok(issued?.status === 200);
  const joined = lines.join("\n");
  for (const secret of ["n@contoh.example", issued.status === 200 ? issued.challengeId : "", h.codeOf("n@contoh.example")!]) {
    assert.ok(!joined.includes(secret), `not logged: ${secret}`);
  }
});

test("the route: phase one answers {success, challenge_id}, an unknown action is refused, the final post carries the proof", async () => {
  const route = await import("../pages/api/platform/signup.ts");
  const h = await harness();
  const env = { ...h.env, EMAIL: { send: async (message: Mail) => (h.mails.push(message), { messageId: "m" }) }, TURNSTILE_SECRET_KEY: "s", TURNSTILE_VERIFY_URL: "https://turnstile.test/siteverify" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ success: true })) as typeof fetch;
  const post = (body: Record<string, unknown>) =>
    route.POST({
      request: new Request("https://adsbook.id/api/platform/signup", { method: "POST", headers: { "content-type": "application/json", origin: "https://adsbook.id", "cf-connecting-ip": "198.51.100.200" }, body: JSON.stringify(body) }),
      url: new URL("https://adsbook.id/api/platform/signup"),
      locals: { runtimeEnv: env },
    } as never) as Promise<Response>;
  try {
    const requested = await post({ action: "request_email_code", email: "o@contoh.example", turnstile_token: "t" });
    assert.equal(requested.status, 200);
    assert.equal(requested.headers.get("cache-control"), "no-store");
    const body = (await requested.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["challenge_id", "success"]);
    assert.equal(body.success, true);
    assert.match(String(body.challenge_id), /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await post({ action: "skip_verification", email: "o@contoh.example" })).status, 400);
    const missing = await post({ store_name: "Toko O", slug: "toko-o", email: "o@contoh.example", password: "kata-sandi-panjang-1", terms: true, turnstile_token: "t" });
    assert.equal(missing.status, 400);
    assert.ok(((await missing.json()) as { errors: Record<string, string> }).errors.emailCode);
    await quiet(async () => {
      const finished = await post({ store_name: "Toko O", slug: "toko-o", email: "o@contoh.example", password: "kata-sandi-panjang-1", terms: true, turnstile_token: "t", challenge_id: body.challenge_id, email_code: h.codeOf("o@contoh.example") });
      assert.equal(finished.status, 500, "the proof passed; the stub store is what refused");
    });
    assert.equal(h.opened.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a store failure on the per-network code limit refuses the request: no challenge, no mail", async () => {
  const h = await harness();
  h.db.failWhen = /rate_limits/;
  let refused: Awaited<ReturnType<typeof h.requestCode>> | undefined;
  await quiet(async () => {
    refused = await h.requestCode("p@contoh.example");
  });
  h.db.failWhen = null;
  assert.equal(refused?.status, 429);
  assert.equal(h.count("signup_email_challenges"), 0);
  assert.equal(h.mails.length, 0);
  // The store back: the same address is served.
  assert.equal((await h.requestCode("p@contoh.example")).status, 200);
});

test("retention: the platform job deletes challenge rows only once they left the hourly cap window, oldest first, bounded", async () => {
  const { runPlatformJobs, JOB_BATCH } = await import("./jobs.ts");
  const { deleteRetiredChallenges } = await import("./signup-verification.ts");
  const h = await harness();
  const insert = h.db.sqlite.prepare(
    "INSERT INTO signup_email_challenges (challenge_id_hash, email_digest, code_digest, state, attempts, created_at, expires_at, consumed_by) VALUES (?, ?, ?, ?, 0, ?, ?, CASE WHEN ?4 = 'consumed' THEN 'n' END)",
  );
  const hex = (seed: number) => seed.toString(16).padStart(64, "0");
  const now = T0 + 10 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  // One just outside the window, one just inside, in each state the job must not treat differently.
  const rows: Array<[number, string, number]> = [
    [1, "consumed", now - HOUR - 1],
    [2, "sent", now - HOUR - 1],
    [3, "void", now - HOUR],
    [4, "sent", now - HOUR + 1],
    [5, "exhausted", now - 5 * 60 * 1000],
  ];
  for (const [seed, state, created] of rows) {
    insert.run(hex(seed), hex(100 + seed), hex(200 + seed), state, created, created + SIGNUP_CODE_TTL_MS);
  }
  const result = await runPlatformJobs(h.db, new Date(now));
  assert.equal(result.signupChallenges, 3);
  assert.deepEqual(
    h.db.sqlite.prepare("SELECT challenge_id_hash FROM signup_email_challenges ORDER BY created_at").all().map((row) => (row as { challenge_id_hash: string }).challenge_id_hash),
    [hex(4), hex(5)],
    "a row still inside the hour keeps counting toward the cap",
  );

  // Bounded: one run removes at most `limit` rows, oldest first; the rest drain on later runs.
  for (let seed = 10; seed < 15; seed += 1) insert.run(hex(seed), hex(100), hex(200 + seed), "sent", now - 2 * HOUR - seed, now - 2 * HOUR - seed + SIGNUP_CODE_TTL_MS);
  assert.equal(Number((await deleteRetiredChallenges(h.db, now, 2).run()).meta.changes), 2);
  assert.deepEqual(
    h.db.sqlite.prepare("SELECT challenge_id_hash FROM signup_email_challenges WHERE created_at < ? ORDER BY created_at").all(now - HOUR).map((row) => (row as { challenge_id_hash: string }).challenge_id_hash),
    [hex(12), hex(11), hex(10)],
    "the two oldest went first",
  );
  assert.ok(JOB_BATCH > 0);
});

test("retention never weakens the send cap: after the job, an address still at its cap is still refused", async () => {
  const { runPlatformJobs } = await import("./jobs.ts");
  const h = await harness();
  for (let sent = 0; sent < SIGNUP_CODE_SENDS_PER_HOUR; sent += 1) {
    assert.equal((await h.requestCode("q@contoh.example")).status, 200);
    h.advance(61_000);
  }
  assert.equal((await runPlatformJobs(h.db, new Date(T0 + SIGNUP_CODE_SENDS_PER_HOUR * 61_000))).signupChallenges, 0);
  assert.equal((await h.requestCode("q@contoh.example")).status, 429);
});

test("a replay of a challenge the job already deleted is refused like an unknown id", async () => {
  const { runPlatformJobs } = await import("./jobs.ts");
  const h = await harness();
  const issued = await h.requestCode("r@contoh.example");
  assert.ok(issued.status === 200);
  if (issued.status !== 200) return;
  const code = h.codeOf("r@contoh.example")!;
  h.advance(2 * 60 * 60 * 1000);
  assert.equal((await runPlatformJobs(h.db, new Date(T0 + 2 * 60 * 60 * 1000))).signupChallenges, 1);
  assert.equal((await h.finish("r@contoh.example", issued.challengeId, code)).status, 400);
  h.nothingReserved();
});
