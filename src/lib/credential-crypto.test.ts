// T-48 / ADR-040: stored provider credentials are sealed per tenant and column,
// and every failure reads as "not set" — never plaintext, never partial.
import assert from "node:assert/strict";
import test from "node:test";

import {
  bindCredentials,
  CredentialKeyUnavailableError,
  credentialsAvailable,
  encryptStoredCredentials,
  isSealedCredential,
  openCredential,
  parseCredentialKey,
  sealCredential,
  STORE_CREDENTIAL_COLUMNS,
} from "./credential-crypto.ts";
import { createSqliteD1 } from "../platform/testing/sqlite-d1.ts";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const env = (key = KEY_A, previous?: string) => ({ PLATFORM_CREDENTIAL_KEY: key, ...(previous ? { PLATFORM_CREDENTIAL_KEY_PREVIOUS: previous } : {}) });
const handle = (tenantId: string, environment: Record<string, unknown> = env()) => bindCredentials({}, tenantId, environment);
const quiet = async <T>(run: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await run();
  } finally {
    console.warn = warn;
  }
};

test("a sealed credential opens for its own tenant and column, and is never the plaintext", async () => {
  const database = handle("t-a");
  const sealed = await sealCredential(database, "mengantar_api_key", "mengantar-secret-123");
  assert.match(sealed, /^enc:v1:1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(sealed, /mengantar-secret/);
  assert.equal(await openCredential(database, "mengantar_api_key", sealed), "mengantar-secret-123");
  assert.notEqual(await sealCredential(database, "mengantar_api_key", "mengantar-secret-123"), sealed, "a fresh IV each time");
  assert.equal(await sealCredential(database, "mengantar_api_key", ""), "", "a clear stays a clear");
});

test("a value moved to another tenant or another column does not open", async () => {
  const sealed = await sealCredential(handle("t-a"), "mengantar_api_key", "secret-of-a");
  await quiet(async () => {
    assert.equal(await openCredential(handle("t-b"), "mengantar_api_key", sealed), null, "wrong tenant");
    assert.equal(await openCredential(handle("t-a"), "autolaris_api_key", sealed), null, "wrong column");
    assert.equal(await openCredential(handle("t-a", env(KEY_B)), "mengantar_api_key", sealed), null, "wrong platform key");
  });
});

test("a tampered or malformed value reads as not set, never partially", async () => {
  const database = handle("t-a");
  const sealed = await sealCredential(database, "meta_capi_token", "EAAB-token");
  const [prefix, body] = [sealed.slice(0, sealed.lastIndexOf(":") + 1), sealed.slice(sealed.lastIndexOf(":") + 1)];
  const flipped = prefix + (body[0] === "A" ? "B" : "A") + body.slice(1);
  await quiet(async () => {
    assert.equal(await openCredential(database, "meta_capi_token", flipped), null);
    assert.equal(await openCredential(database, "meta_capi_token", sealed.slice(0, -4)), null);
  });
  assert.equal(await openCredential(database, "meta_capi_token", "enc:v1:1:only-two"), null);
  assert.equal(await openCredential(database, "meta_capi_token", sealed.replace("enc:v1:1:", "enc:v1:9:")), null, "unknown key version");
});

test("without a usable platform key nothing is stored and nothing is read (fail closed)", async () => {
  const sealed = await sealCredential(handle("t-a"), "mengantar_api_key", "secret");
  for (const environment of [{}, { PLATFORM_CREDENTIAL_KEY: "too-short" }, { PLATFORM_CREDENTIAL_KEY: Buffer.alloc(16).toString("base64") }]) {
    const keyless = handle("t-a", environment);
    assert.equal(credentialsAvailable(keyless), false);
    await assert.rejects(sealCredential(keyless, "mengantar_api_key", "secret"), CredentialKeyUnavailableError);
    assert.equal(await openCredential(keyless, "mengantar_api_key", sealed), null);
    assert.equal(await openCredential(keyless, "mengantar_api_key", "legacy-plaintext"), null, "plaintext is not served without a key either");
  }
  const unbound = {};
  await assert.rejects(sealCredential(unbound, "mengantar_api_key", "secret"), CredentialKeyUnavailableError);
  assert.equal(await openCredential(unbound, "mengantar_api_key", sealed), null);
  assert.equal(await openCredential(null, "mengantar_api_key", sealed), null);
});

test("key format: base64 32 bytes, optional v<N>: version prefix", () => {
  assert.deepEqual(parseCredentialKey(`v3:${KEY_A}`)?.version, "3");
  assert.equal(parseCredentialKey(KEY_A)?.version, "1");
  assert.equal(parseCredentialKey(KEY_A.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))?.raw.length, 32, "base64url accepted");
  assert.equal(parseCredentialKey("v1:not base64!"), null);
  assert.equal(parseCredentialKey(undefined), null);
});

test("the sweep seals legacy plaintext and re-seals an older key version, once, without touching a newer save", async () => {
  const database = createSqliteD1();
  database.sqlite.exec(`CREATE TABLE stores (id INTEGER PRIMARY KEY, ${STORE_CREDENTIAL_COLUMNS.map((column) => `${column} TEXT`).join(", ")})`);
  database.sqlite.exec(`INSERT INTO stores (id, mengantar_api_key, meta_capi_token, google_ads_refresh_token) VALUES (1, 'plain-mengantar', 'plain-meta', NULL)`);
  bindCredentials(database, "t-a", env(`v1:${KEY_A}`));
  // AutoLaris was sealed under the old key v1; then the platform rotates to v2.
  const oldSealed = await sealCredential(database, "autolaris_api_key", "autolaris-old-key");
  database.sqlite.prepare("UPDATE stores SET autolaris_api_key = ?").run(oldSealed);
  bindCredentials(database, "t-a", env(`v2:${KEY_B}`, `v1:${KEY_A}`));

  assert.deepEqual(await encryptStoredCredentials(database), { sealed: 3, skipped: false });
  const row = database.sqlite.prepare("SELECT * FROM stores").get() as Record<string, string | null>;
  for (const column of STORE_CREDENTIAL_COLUMNS) {
    const value = row[column];
    if (value === null) continue;
    assert.ok(isSealedCredential(value), `${column} is sealed`);
    assert.match(value, /^enc:v1:2:/, `${column} is under the current key`);
  }
  assert.doesNotMatch(JSON.stringify(row), /plain-|autolaris-old-key/, "no plaintext credential is left in the row");
  assert.equal(await openCredential(database, "mengantar_api_key", row.mengantar_api_key), "plain-mengantar");
  assert.equal(await openCredential(database, "autolaris_api_key", row.autolaris_api_key), "autolaris-old-key");
  assert.deepEqual(await encryptStoredCredentials(database), { sealed: 0, skipped: false }, "idempotent");

  // Without a key the sweep does nothing at all.
  bindCredentials(database, "t-a", {});
  assert.deepEqual(await encryptStoredCredentials(database), { sealed: 0, skipped: true });
});

test("rotation between two unprefixed keys keeps the old one readable, and the sweep moves values to the new key (T-48 review P1)", async () => {
  const database = createSqliteD1();
  database.sqlite.exec(`CREATE TABLE stores (id INTEGER PRIMARY KEY, ${STORE_CREDENTIAL_COLUMNS.map((column) => `${column} TEXT`).join(", ")})`);
  bindCredentials(database, "t-a", env(KEY_A));
  database.sqlite.prepare("INSERT INTO stores (id, mengantar_api_key) VALUES (1, ?)").run(await sealCredential(database, "mengantar_api_key", "under-key-a"));
  // Both keys unprefixed: both are version "1".
  bindCredentials(database, "t-a", env(KEY_B, KEY_A));
  const before = (database.sqlite.prepare("SELECT mengantar_api_key AS k FROM stores").get() as { k: string }).k;
  assert.equal(await openCredential(database, "mengantar_api_key", before), "under-key-a", "the previous key still opens it");
  assert.deepEqual(await encryptStoredCredentials(database), { sealed: 1, skipped: false }, "a value only the previous key opens is re-sealed");
  const after = (database.sqlite.prepare("SELECT mengantar_api_key AS k FROM stores").get() as { k: string }).k;
  bindCredentials(database, "t-a", env(KEY_B));
  assert.equal(await openCredential(database, "mengantar_api_key", after), "under-key-a", "the new key alone opens it after the sweep");
});

test("an envelope this code does not understand is unreadable, never plaintext, and the sweep leaves it alone (T-48 review)", async () => {
  const database = createSqliteD1();
  database.sqlite.exec(`CREATE TABLE stores (id INTEGER PRIMARY KEY, ${STORE_CREDENTIAL_COLUMNS.map((column) => `${column} TEXT`).join(", ")})`);
  bindCredentials(database, "t-a", env());
  const sealed = await sealCredential(database, "mengantar_api_key", "secret");
  const foreign = sealed.replace("enc:v1:", "enc:v2:");
  for (const value of [foreign, "enc:", "enc:anything", "enc:v1"]) {
    assert.equal(await openCredential(database, "mengantar_api_key", value), null, value);
  }
  database.sqlite.prepare("INSERT INTO stores (id, mengantar_api_key) VALUES (1, ?)").run(foreign);
  await quiet(async () => assert.deepEqual(await encryptStoredCredentials(database), { sealed: 0, skipped: false }));
  assert.equal((database.sqlite.prepare("SELECT mengantar_api_key AS k FROM stores").get() as { k: string }).k, foreign);
});

test("known answer: an independent HKDF + AES-256-GCM with the ADR-040 salt, info and AAD opens the sealed value", async () => {
  const { createDecipheriv, hkdfSync } = await import("node:crypto");
  const sealed = await sealCredential(handle("tenant-x"), "autolaris_api_key", "rahasia-autolaris");
  const [, , version, ivText, bodyText] = sealed.split(":");
  assert.equal(version, "1");
  const iv = Buffer.from(ivText, "base64url");
  const body = Buffer.from(bodyText, "base64url");
  const open = (salt: string, info: string, aad: string) => {
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(KEY_A, "base64"), salt, info, 32));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  };
  assert.equal(open("tenant-x", "adsbook.id/provider-credentials/v1", "tenant-x\nautolaris_api_key"), "rahasia-autolaris");
  assert.throws(() => open("", "adsbook.id/provider-credentials/v1", "tenant-x\nautolaris_api_key"), "the tenant id is the HKDF salt");
  assert.throws(() => open("tenant-x", "other-info", "tenant-x\nautolaris_api_key"), "the ADR-040 info string");
});

test("the sweep never overwrites a save that lands between its read and its write (T-48 review)", async () => {
  const inner = createSqliteD1();
  inner.sqlite.exec(`CREATE TABLE stores (id INTEGER PRIMARY KEY, ${STORE_CREDENTIAL_COLUMNS.map((column) => `${column} TEXT`).join(", ")})`);
  inner.sqlite.exec("INSERT INTO stores (id, mengantar_api_key) VALUES (1, 'legacy-plaintext')");
  let raced = false;
  let newer = "";
  // A handle that lets an admin save land just before the sweep's UPDATE runs.
  const database = {
    prepare(sql: string) {
      const statement = inner.prepare(sql);
      if (!/^UPDATE stores SET mengantar_api_key/.test(sql)) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              if (!raced) {
                raced = true;
                inner.sqlite.prepare("UPDATE stores SET mengantar_api_key = ?").run(newer);
              }
              return bound.run();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  bindCredentials(database, "t-a", env());
  newer = await sealCredential(database, "mengantar_api_key", "saved-by-the-owner");
  assert.deepEqual(await encryptStoredCredentials(database), { sealed: 0, skipped: false });
  assert.equal(raced, true);
  assert.equal((inner.sqlite.prepare("SELECT mengantar_api_key AS k FROM stores").get() as { k: string }).k, newer, "the owner's save is kept exactly");
});

test("re-versioning the same key material (v1:A → v2:A) keeps v1 envelopes readable and the sweep moves them to v2 (T-48 re-review)", async () => {
  const database = createSqliteD1();
  database.sqlite.exec(`CREATE TABLE stores (id INTEGER PRIMARY KEY, ${STORE_CREDENTIAL_COLUMNS.map((column) => `${column} TEXT`).join(", ")})`);
  bindCredentials(database, "t-a", env(`v1:${KEY_A}`));
  database.sqlite.prepare("INSERT INTO stores (id, meta_capi_token) VALUES (1, ?)").run(await sealCredential(database, "meta_capi_token", "same-material"));
  bindCredentials(database, "t-a", env(`v2:${KEY_A}`, `v1:${KEY_A}`));
  const before = (database.sqlite.prepare("SELECT meta_capi_token AS k FROM stores").get() as { k: string }).k;
  assert.equal(await openCredential(database, "meta_capi_token", before), "same-material");
  assert.deepEqual(await encryptStoredCredentials(database), { sealed: 1, skipped: false });
  const after = (database.sqlite.prepare("SELECT meta_capi_token AS k FROM stores").get() as { k: string }).k;
  assert.match(after, /^enc:v1:2:/);
  bindCredentials(database, "t-a", env(`v2:${KEY_A}`));
  assert.equal(await openCredential(database, "meta_capi_token", after), "same-material", "readable after the previous key is removed");
});
