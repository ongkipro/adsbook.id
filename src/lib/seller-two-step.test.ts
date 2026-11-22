import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteD1, type SqliteD1 } from "../platform/testing/sqlite-d1.ts";
import { withTestCredentials } from "../platform/testing/credentials.ts";
import { bindCredentials, openCredential } from "./credential-crypto.ts";
import { totpCode } from "../platform/admin/totp.ts";
import { hashAdminPassword } from "./admin-credentials.ts";
import { splitMigrationStatements } from "./schema-version.ts";
import {
  CHALLENGE_MAX_ATTEMPTS,
  FACTOR_FAILURE_LIMIT,
  beginEnrollment,
  clearTwoStep,
  confirmEnrollment,
  createLoginChallenge,
  disableOwnTwoStep,
  forgotPasswordUrl,
  proveSecondFactor,
  FACTOR_DAILY_LIMIT,
  PASSWORD_CHECK_LIMIT,
  RECOVERY_CODE_COUNT,
  sealTwoStepSecrets,
  twoStepEnrollmentOpen,
  recoveryCodesLeft,
  redeemLoginChallenge,
  twoStepEnabled,
} from "./seller-two-step.ts";

const PASSWORD = "kata-sandi-panjang-1";
const T0 = Date.parse("2026-11-22T10:00:00Z");

/** The full checked-in chain: the test breaks if the columns drift. */
async function store(tenantId = "t_alfa"): Promise<SqliteD1> {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
    for (const statement of splitMigrationStatements(readFileSync(new URL(name, dir), "utf8"))) sqlite.exec(statement);
  }
  sqlite.exec("DELETE FROM admin_credentials");
  const hash = await hashAdminPassword(PASSWORD);
  sqlite.prepare("INSERT INTO admin_credentials (id, username, email, role, password_hash, must_change_password, updated_at) VALUES (1, 'owner@alfa.test', 'owner@alfa.test', 'owner', ?, 0, '2026-11-01T00:00:00.000Z'), (2, 'cs_rina', NULL, 'customer_service', ?, 0, '2026-11-01T00:00:00.000Z')").run(hash, hash);
  return withTestCredentials(createSqliteD1(sqlite), tenantId);
}

const col = (db: SqliteD1, sql: string, ...args: (string | number)[]) => db.sqlite.prepare(sql).get(...args) as Record<string, unknown> | undefined;

async function enroll(db: SqliteD1, id = 1, at = T0) {
  const begun = await beginEnrollment(db, id, PASSWORD, "owner@alfa.test");
  assert.ok(begun.ok);
  const done = await confirmEnrollment(db, id, { password: PASSWORD, secret: begun.secret, code: await totpCode(begun.secret, Math.floor(at / 30_000)) }, at);
  assert.ok(done.ok, JSON.stringify(done));
  return { secret: begun.secret, codes: done.recoveryCodes, uri: begun.uri };
}

test("T-57 enrollment: needs the password, activates only on a proven code, seals the secret, ends the user's sessions and moves the revision", async () => {
  const db = await store();
  assert.deepEqual(await beginEnrollment(db, 1, "salah-salah-salah", "x"), { ok: false, error: "Password saat ini salah." });
  const begun = await beginEnrollment(db, 1, PASSWORD, "owner@alfa.test");
  assert.ok(begun.ok);
  assert.match(begun.secret, /^[A-Z2-7]{32}$/);
  assert.match(begun.uri, /^otpauth:\/\/totp\/adsbook\.id:owner%40alfa\.test\?secret=/);
  assert.equal(await twoStepEnabled(db, 1), false, "nothing stored before it is proven");

  db.sqlite.exec("INSERT INTO admin_sessions (jti, username, role, credential_updated_at, expires_at, created_at) VALUES ('s1', 'owner@alfa.test', 'owner', '2026-11-01T00:00:00.000Z', '2099-01-01', '2026-11-01'), ('s2', 'cs_rina', 'customer_service', '2026-11-01T00:00:00.000Z', '2099-01-01', '2026-11-01')");
  const step = Math.floor(T0 / 30_000);
  const wrong = await confirmEnrollment(db, 1, { password: PASSWORD, secret: begun.secret, code: (await totpCode(begun.secret, step + 5)) }, T0);
  assert.equal(wrong.ok, false);
  const noPassword = await confirmEnrollment(db, 1, { password: "salah-salah-salah", secret: begun.secret, code: await totpCode(begun.secret, step) }, T0);
  assert.equal(noPassword.ok, false);
  assert.equal(await twoStepEnabled(db, 1), false);

  const done = await confirmEnrollment(db, 1, { password: PASSWORD, secret: begun.secret, code: await totpCode(begun.secret, step) }, T0);
  assert.ok(done.ok);
  assert.equal(done.recoveryCodes.length, 10);
  assert.equal(new Set(done.recoveryCodes).size, 10);
  const row = col(db, "SELECT totp_secret, recovery_codes, updated_at FROM admin_credentials WHERE id = 1")!;
  assert.match(String(row.totp_secret), /^enc:v1:/, "sealed, never plaintext");
  assert.ok(!String(row.totp_secret).includes(begun.secret));
  assert.ok(!String(row.recovery_codes).includes(done.recoveryCodes[0]), "only digests are stored");
  assert.notEqual(row.updated_at, "2026-11-01T00:00:00.000Z", "the revision moved, so password-only handoffs die");
  assert.equal(col(db, "SELECT COUNT(*) AS n FROM admin_sessions WHERE username = 'owner@alfa.test'")!.n, 0, "the owner's sessions ended");
  assert.equal(col(db, "SELECT COUNT(*) AS n FROM admin_sessions WHERE username = 'cs_rina'")!.n, 1, "nobody else's");
  assert.deepEqual(await beginEnrollment(db, 1, PASSWORD, "x"), { ok: false, error: "Verifikasi dua langkah sudah aktif." });
});

test("T-57 enrollment fails closed without the platform credential key: nothing is stored", async () => {
  const db = await store();
  const keyless = bindCredentials(createSqliteD1(db.sqlite), "t_alfa", {});
  const begun = await beginEnrollment(keyless, 1, PASSWORD, "x");
  assert.ok(begun.ok);
  const done = await confirmEnrollment(keyless, 1, { password: PASSWORD, secret: begun.secret, code: await totpCode(begun.secret, Math.floor(T0 / 30_000)) }, T0);
  assert.equal(done.ok, false);
  assert.equal(await twoStepEnabled(keyless, 1), false);
});

test("T-57 second factor: each step once, a recovery code once, and a secret moved to another tenant or user does not open", async () => {
  const db = await store();
  const { secret, codes } = await enroll(db);
  const later = T0 + 60_000;
  const code = await totpCode(secret, Math.floor(later / 30_000));
  assert.equal(await proveSecondFactor(db, 1, code, later), true);
  assert.equal(await proveSecondFactor(db, 1, code, later), false, "replay of the same step");
  assert.equal(await proveSecondFactor(db, 1, await totpCode(secret, Math.floor(T0 / 30_000)), later), false, "an older step");

  assert.equal(await proveSecondFactor(db, 1, codes[0].toUpperCase(), later), true, "a recovery code, any case");
  assert.equal(await proveSecondFactor(db, 1, codes[0], later), false, "used once");
  assert.equal(await recoveryCodesLeft(db, 1), 9);

  // The sealed row copied to another tenant's store, or onto another user, opens nowhere.
  const sealed = col(db, "SELECT totp_secret FROM admin_credentials WHERE id = 1")!.totp_secret as string;
  const other = await store("t_beta");
  other.sqlite.prepare("UPDATE admin_credentials SET totp_secret = ? WHERE id = 1").run(sealed);
  db.sqlite.prepare("UPDATE admin_credentials SET totp_secret = ? WHERE id = 2").run(sealed);
  const fresh = later + 120_000;
  const valid = await totpCode(secret, Math.floor(fresh / 30_000));
  assert.equal(await proveSecondFactor(other, 1, valid, fresh), false, "another tenant");
  assert.equal(await proveSecondFactor(db, 2, valid, fresh), false, "another user");
  assert.equal(await twoStepEnabled(db, 2), true, "an unreadable secret still counts as on (fail closed)");
});

test("T-57 second factor: a credential's wrong guesses are capped across every challenge", async () => {
  const db = await store();
  const { secret } = await enroll(db);
  for (let index = 0; index < FACTOR_FAILURE_LIMIT; index += 1) assert.equal(await proveSecondFactor(db, 1, "000000", T0 + 60_000), false);
  const now = T0 + 90_000;
  assert.equal(await proveSecondFactor(db, 1, await totpCode(secret, Math.floor(now / 30_000)), now), false, "even the right code, once the budget is spent");
});

test("T-57 challenge: single use, 5 attempts, 5 minutes, bound to one credential", async () => {
  const db = await store();
  const { secret } = await enroll(db);
  const revision = col(db, "SELECT updated_at FROM admin_credentials WHERE id = 1")!.updated_at as string;
  const at = new Date(T0 + 60_000);
  const token = await createLoginChallenge(db, { id: 1, updatedAt: revision }, at);
  assert.equal(col(db, "SELECT COUNT(*) AS n FROM admin_login_challenges WHERE token_hash = ?", token)!.n, 0, "only the digest is stored");

  assert.deepEqual(await redeemLoginChallenge(db, token, "123456", at, 2), { ok: false, reason: "invalid" }, "another credential's challenge");
  assert.deepEqual(await redeemLoginChallenge(db, "f".repeat(64), "123456", at), { ok: false, reason: "invalid" });
  assert.deepEqual(await redeemLoginChallenge(db, token, "000000", at), { ok: false, reason: "wrong_code" });
  const good = await redeemLoginChallenge(db, token, await totpCode(secret, Math.floor(at.getTime() / 30_000)), at, 1);
  assert.deepEqual(good, { ok: true, credentialId: 1, credentialUpdatedAt: revision });
  assert.deepEqual(await redeemLoginChallenge(db, token, await totpCode(secret, Math.floor(at.getTime() / 30_000) + 1), at), { ok: false, reason: "invalid" }, "single use");

  const second = await createLoginChallenge(db, { id: 1, updatedAt: revision }, at);
  for (let index = 1; index < CHALLENGE_MAX_ATTEMPTS; index += 1) assert.equal((await redeemLoginChallenge(db, second, "000000", at)).ok, false);
  assert.deepEqual(await redeemLoginChallenge(db, second, "000000", at), { ok: false, reason: "exhausted" });
  const next = new Date(at.getTime() + 30_000);
  assert.deepEqual(await redeemLoginChallenge(db, second, await totpCode(secret, Math.floor(next.getTime() / 30_000)), next), { ok: false, reason: "exhausted" }, "the right code no longer helps");

  const third = await createLoginChallenge(db, { id: 1, updatedAt: revision }, at);
  const expired = new Date(at.getTime() + 5 * 60_000 + 1);
  assert.deepEqual(await redeemLoginChallenge(db, third, await totpCode(secret, Math.floor(expired.getTime() / 30_000)), expired), { ok: false, reason: "invalid" });
});

test("T-57 turning off: the own path needs password and factor; the owner path clears and kills pending challenges; a password reset keeps it", async () => {
  const db = await store();
  const { secret } = await enroll(db, 2);
  const at = T0 + 60_000;
  assert.equal((await disableOwnTwoStep(db, 2, { password: PASSWORD, code: "000000" }, at)).ok, false);
  assert.equal((await disableOwnTwoStep(db, 2, { password: "salah-salah-salah", code: await totpCode(secret, Math.floor(at / 30_000)) }, at)).ok, false);
  assert.equal(await twoStepEnabled(db, 2), true);

  // A password reset (owner-managed or /lupa-password) writes password_hash and updated_at only.
  db.sqlite.exec("UPDATE admin_credentials SET password_hash = 'x', updated_at = '2026-12-01T00:00:00.000Z' WHERE id = 2");
  assert.equal(await twoStepEnabled(db, 2), true, "a reset neither disables the factor");

  await createLoginChallenge(db, { id: 2, updatedAt: "2026-12-01T00:00:00.000Z" }, new Date(at));
  await clearTwoStep(db, 2);
  assert.equal(await twoStepEnabled(db, 2), false);
  assert.equal(col(db, "SELECT COUNT(*) AS n FROM admin_login_challenges WHERE credential_id = 2")!.n, 0);
});

test("T-57 the /hello 'Lupa password' link points at the platform page, keeping a local dev host", () => {
  assert.equal(forgotPasswordUrl(new URL("https://toko.adsbook.my.id/hello")), "https://adsbook.id/lupa-password");
  assert.equal(forgotPasswordUrl(new URL("https://www.tokosaya.com/hello")), "https://adsbook.id/lupa-password");
  assert.equal(forgotPasswordUrl(new URL("http://toko-alfa.localhost:4399/hello")), "http://app.localhost:4399/lupa-password");
});

test("T-57 enrollment stays closed unless the Worker sets SELLER_TWO_STEP=on", () => {
  assert.equal(twoStepEnrollmentOpen(undefined), false);
  assert.equal(twoStepEnrollmentOpen({}), false);
  for (const value of ["", "off", "true", "1", "ON", true]) assert.equal(twoStepEnrollmentOpen({ SELLER_TWO_STEP: value }), false, String(value));
  assert.equal(twoStepEnrollmentOpen({ SELLER_TWO_STEP: "on" }), true);
  assert.equal(twoStepEnrollmentOpen({ SELLER_TWO_STEP: " on " }), true);
});

test("T-57 review: a parallel wave of guesses is cut at the limits, not evaluated whole", async () => {
  const db = await store();
  const { secret } = await enroll(db);
  const revision = col(db, "SELECT updated_at FROM admin_credentials WHERE id = 1")!.updated_at as string;
  const at = new Date(T0 + 60_000);
  const right = await totpCode(secret, Math.floor(at.getTime() / 30_000));

  // One challenge, 50 wrong codes at once, then the right one: the challenge allows five evaluations in total.
  const token = await createLoginChallenge(db, { id: 1, updatedAt: revision }, at);
  const wave = await Promise.all(Array.from({ length: 50 }, () => redeemLoginChallenge(db, token, "000000", at)));
  assert.equal(wave.filter((outcome) => !outcome.ok && outcome.reason === "wrong_code").length, CHALLENGE_MAX_ATTEMPTS - 1);
  assert.equal(col(db, "SELECT attempts FROM admin_login_challenges")!.attempts, CHALLENGE_MAX_ATTEMPTS);
  assert.deepEqual(await redeemLoginChallenge(db, token, right, at), { ok: false, reason: "exhausted" });

  // Across many fresh challenges (a known password mints them freely), the per-credential budget caps the
  // total: 45 wrong guesses and, behind them in the same wave, the right code. Only FACTOR_FAILURE_LIMIT
  // codes are evaluated, so the right one is never reached. (A peek-then-record budget let it through.)
  db.sqlite.exec("DELETE FROM rate_limits");
  const tokens = await Promise.all(Array.from({ length: 10 }, () => createLoginChallenge(db, { id: 1, updatedAt: revision }, at)));
  const guesses = tokens.slice(0, 9).flatMap((each) => Array.from({ length: 5 }, () => redeemLoginChallenge(db, each, "000000", at)));
  const outcomes = await Promise.all([...guesses, redeemLoginChallenge(db, tokens[9], right, at)]);
  assert.equal(outcomes.at(-1)!.ok, false, "the right code behind a wave is not evaluated");
  // The budget window runs on the wall clock (rate-limit.ts), so the reopening after 15 minutes is not simulated here.
});

test("T-57 review: a key rotation re-seals the two-step secret, so retiring the previous key strands no one", async () => {
  const db = await store();
  await enroll(db);
  const oldKey = Buffer.alloc(32, 1).toString("base64");
  const newKey = Buffer.alloc(32, 2).toString("base64");
  bindCredentials(db, "t_alfa", { PLATFORM_CREDENTIAL_KEY: newKey, PLATFORM_CREDENTIAL_KEY_PREVIOUS: oldKey });
  assert.equal(await sealTwoStepSecrets(db), 2, "the secret and the recovery-code list");
  assert.equal(await sealTwoStepSecrets(db), 0, "idempotent");
  bindCredentials(db, "t_alfa", { PLATFORM_CREDENTIAL_KEY: newKey });
  const stored = col(db, "SELECT totp_secret FROM admin_credentials WHERE id = 1")!.totp_secret;
  assert.match(String(await openCredential(db, "admin_credentials.totp_secret:1", stored)), /^[A-Z2-7]{32}$/, "the new key alone opens it");
  assert.equal(await openCredential(db, "admin_credentials.totp_secret:2", stored), null, "still bound to its own credential");
  assert.equal(await recoveryCodesLeft(db, 1), RECOVERY_CODE_COUNT, "the recovery codes still open under the new key alone");
});

test("T-57 hardening: recovery-code digests are sealed, so a database copy cannot test guesses offline", async () => {
  const db = await store();
  const { codes } = await enroll(db);
  const stored = String(col(db, "SELECT recovery_codes FROM admin_credentials WHERE id = 1")!.recovery_codes);
  assert.ok(!stored.startsWith("["), "not a plain JSON list of digests");
  const digest = createHash("sha256").update(codes[0].replace("-", "")).digest("hex");
  assert.ok(!stored.includes(digest), "no digest is readable in the row");
  assert.equal(await openCredential(db, "admin_credentials.recovery_codes:2", stored), null, "bound to its own credential");
  assert.equal(await recoveryCodesLeft(db, 1), RECOVERY_CODE_COUNT);
  assert.equal(await proveSecondFactor(db, 1, codes[0], T0 + 60_000), true);
  assert.equal(await proveSecondFactor(db, 1, codes[0], T0 + 60_000), false, "still single use");
  assert.equal(await recoveryCodesLeft(db, 1), RECOVERY_CODE_COUNT - 1);
});

test("T-57 hardening: a daily ceiling on code checks, and a limit on password checks behind the profile endpoint", async () => {
  const db = await store();
  const { secret: enrolledSecret } = await enroll(db);
  // Spend the whole daily ceiling in 15-minute rounds (each round's budget is cleared, as if the window passed).
  for (let spent = 0; spent < FACTOR_DAILY_LIMIT; spent += 1) {
    if (spent % FACTOR_FAILURE_LIMIT === 0) db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'two-step-fail:%'");
    assert.equal(await proveSecondFactor(db, 1, "000000", T0), false);
  }
  db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'two-step-fail:%'");
  const totp = await totpCode(enrolledSecret, Math.floor((T0 + 90_000) / 30_000));
  assert.equal(await proveSecondFactor(db, 1, totp, T0 + 90_000), false, "past the daily ceiling even the right code is not checked");

  assert.equal(PASSWORD_CHECK_LIMIT, 10);
  for (let index = 0; index < PASSWORD_CHECK_LIMIT; index += 1) assert.equal((await beginEnrollment(db, 2, "salah-salah-salah", "x")).ok, false);
  assert.deepEqual(await beginEnrollment(db, 2, PASSWORD, "cs"), { ok: false, error: "Password saat ini salah." }, "the right password waits out the window");
});
