// The platform's own IPs on Komdigi's Trust+ list (PLATFORM-RUNBOOK §6): found,
// logged, and sent to the operator once a day; an unreadable list proves nothing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { ensureControlPlane } from "./control-plane.ts";
import { createSqliteD1 } from "./testing/sqlite-d1.ts";
import { checkTrustPositif, TRUST_POSITIF_IP_LIST, watchedHosts } from "./trust-watch.ts";

const dir = new URL("./migrations/", import.meta.url);
const CHAIN = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
const DNS: Record<string, string[]> = {
  "adsbook.id": ["104.21.41.93", "172.67.146.101"],
  "app.adsbook.id": ["104.21.41.93", "172.67.146.101"],
  "adsbook.my.id": ["104.21.7.149", "172.67.136.112"],
  "cname.adsbook.my.id": ["104.21.7.149", "172.67.136.112"],
};

function fakeNet(list: string | null) {
  const posts: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") {
      const ips = DNS[url.searchParams.get("name") ?? ""] ?? [];
      return Response.json({ Answer: [{ type: 5, data: "alias." }, ...ips.map((data) => ({ type: 1, data }))] });
    }
    if (String(input) === TRUST_POSITIF_IP_LIST) return list === null ? new Response("down", { status: 503 }) : new Response(list);
    if (url.hostname === "hooks.example") {
      posts.push(JSON.parse(String(init?.body)).text);
      return new Response("ok");
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetcher, posts };
}

test("the watched hosts are the platform hosts and the seller zone; a local suffix adds none", () => {
  assert.deepEqual(watchedHosts({}), ["adsbook.id", "app.adsbook.id", "adsbook.my.id", "cname.adsbook.my.id"]);
  assert.deepEqual(watchedHosts({ TENANT_HOST_SUFFIX: "localhost" }), ["adsbook.id", "app.adsbook.id"]);
});

test("a listed IP of the seller zone is reported per host and sent once a day; the platform's clean IPs are not", async () => {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  const env = { PLATFORM_ALERT_WEBHOOK_URL: "https://hooks.example/notify" };
  const net = fakeNet("1.2.3.4\n104.21.7.149\r\n172.67.136.112\n9.9.9.9\n");
  const errors: unknown[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const day = new Date("2026-11-17T01:07:00Z");
    const first = await checkTrustPositif(env, db, day, net.fetcher);
    assert.equal(first?.checked, 4);
    assert.deepEqual(first?.blocked, [
      { host: "adsbook.my.id", ip: "104.21.7.149" }, { host: "adsbook.my.id", ip: "172.67.136.112" },
      { host: "cname.adsbook.my.id", ip: "104.21.7.149" }, { host: "cname.adsbook.my.id", ip: "172.67.136.112" },
    ]);
    assert.equal(net.posts.length, 2, "one notice per IP, not per host");
    assert.match(net.posts[0], /^\[adsbook\.id\] IP 104\.21\.7\.149 \(adsbook\.my\.id\) ada di daftar blokir Trust\+/);
    await checkTrustPositif(env, db, new Date("2026-11-17T23:00:00Z"), net.fetcher);
    assert.equal(net.posts.length, 2, "the same day stays quiet");
    await checkTrustPositif(env, db, new Date("2026-11-18T01:07:00Z"), net.fetcher);
    assert.equal(net.posts.length, 4, "a new day while still listed reminds again");
    assert.ok(errors.filter((entry) => (entry as unknown[])[0] === "trustpositif-ip-blocked").length >= 4, "every run logs it");
  } finally {
    console.error = previous;
  }
});

test("nothing listed: no notice; the list unreachable: null, never a false alarm", async () => {
  const db = createSqliteD1();
  await ensureControlPlane(db, CHAIN);
  const env = { PLATFORM_ALERT_WEBHOOK_URL: "https://hooks.example/notify" };
  const clean = fakeNet("1.2.3.4\n");
  assert.deepEqual((await checkTrustPositif(env, db, new Date(), clean.fetcher))?.blocked, []);
  assert.equal(clean.posts.length, 0);
  const down = fakeNet(null);
  const previous = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await checkTrustPositif(env, db, new Date(), down.fetcher), null);
  } finally {
    console.error = previous;
  }
  assert.equal(down.posts.length, 0);
});
