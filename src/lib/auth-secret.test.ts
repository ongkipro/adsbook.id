import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveAuthSecret } from "./auth-secret.ts";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../db/migrations/0058_install_secrets.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare: (sql: string) => {
      let bound: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => {
          bound = values;
          return statement;
        },
        first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(bound as never[])).changes) } }),
      };
      return statement;
    },
  } as unknown as D1Database;
  return { sqlite, d1 };
}

test("the key comes from the tenant's own store; the Worker environment is never read (T-21)", async () => {
  const { sqlite, d1 } = database();
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "e".repeat(48); // a platform-wide value must not become a tenant's key
  try {
    const key = await resolveAuthSecret(d1);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, process.env.AUTH_SECRET);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM install_secrets").get() as { n: number }).n, 1);
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  }
});

test("a strong key is generated once per store, every caller agrees on it, and two tenants never share one", async () => {
  const first = database();
  const [a, b] = await Promise.all([resolveAuthSecret(first.d1), resolveAuthSecret(first.d1)]);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.equal((first.sqlite.prepare("SELECT COUNT(*) AS n FROM install_secrets").get() as { n: number }).n, 1);
  const second = database();
  assert.notEqual(await resolveAuthSecret(second.d1), a);
});

test("an unreadable store or no store fails closed", async () => {
  const broken = {
    prepare: () => {
      throw new Error("D1 unavailable");
    },
  } as unknown as D1Database;
  assert.equal(await resolveAuthSecret(broken), "");
  assert.equal(await resolveAuthSecret(undefined), "");
});

test("the cache is keyed by tenant: a new handle to the same store hits, another tenant never does", async () => {
  const a = database();
  const b = database();
  const secretA = await resolveAuthSecret(a.d1, "tenant-cache-a");
  // A fresh handle (as the tenant capability returns per request) whose reads would fail.
  const unreadable = { prepare: () => { throw new Error("must not read: cached"); } } as unknown as D1Database;
  assert.equal(await resolveAuthSecret(unreadable, "tenant-cache-a"), secretA);
  const secretB = await resolveAuthSecret(b.d1, "tenant-cache-b");
  assert.notEqual(secretB, secretA);
  // No tenant id: no cache entry is read or written.
  assert.equal(await resolveAuthSecret(unreadable), "");
});
