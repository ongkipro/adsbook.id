// TEN-3 (T-20): every shared-resource key carries the tenant. ISO-6 (R2),
// ISO-7 (KV), ISO-8 (edge cache, also in src/lib/edge-cache.test.ts).
import assert from "node:assert/strict";
import test from "node:test";

import { platformKv, tenantCacheKey, tenantKv, tenantR2, tenantR2Key } from "./keys.ts";

function fakeBucket() {
  const objects = new Map<string, { body: string; contentType?: string }>();
  return {
    objects,
    async put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { body: value, contentType: options?.httpMetadata?.contentType });
      return { key } as never;
    },
    async get(key: string) {
      const object = objects.get(key);
      return object
        ? ({ body: object.body, httpMetadata: { contentType: object.contentType }, httpEtag: `"${key}"` } as never)
        : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function fakeKv() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string, type?: "json") {
      const value = values.get(key) ?? null;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

test("ISO-6: the same upload key for two tenants stores two objects, each read back by its own tenant", async () => {
  const bucket = fakeBucket();
  const env = { ASSET_BUCKET: bucket };
  const key = "uploads/2026-11-16/0f3c.webp";
  await tenantR2(env, "t-a")!.put(key, "bytes-of-a");
  await tenantR2(env, "t-b")!.put(key, "bytes-of-b");
  assert.deepEqual([...bucket.objects.keys()].sort(), [`t/t-a/${key}`, `t/t-b/${key}`]);
  assert.equal(((await tenantR2(env, "t-a")!.get(key)) as unknown as { body: string }).body, "bytes-of-a");
  assert.equal(((await tenantR2(env, "t-b")!.get(key)) as unknown as { body: string }).body, "bytes-of-b");
  // A tenant without the object does not see another tenant's.
  await tenantR2(env, "t-a")!.put("content/only-a.png", "a");
  assert.equal(await tenantR2(env, "t-b")!.get("content/only-a.png"), null);
});

test("ISO-6: a key or tenant id that could leave its prefix is refused", () => {
  for (const key of ["../t-b/uploads/x.webp", "uploads/../../t-b/x", "/t/t-b/x", "", "uploads/./x"]) {
    assert.throws(() => tenantR2Key("t-a", key), /invalid object key/, key);
  }
  for (const tenantId of ["", "t/../b", "t:b", "a b", "x".repeat(65)]) {
    assert.throws(() => tenantR2Key(tenantId, "uploads/x.webp"), /invalid tenant id/, tenantId);
  }
  assert.equal(tenantR2({}, "t-a"), undefined, "no binding, no bucket");
});

test("ISO-7: KV keys carry the tenant; the platform has its own prefix", async () => {
  const kv = fakeKv();
  const env = { SESSION: kv };
  await tenantKv(env, "t-a")!.put("store-config:x", JSON.stringify(["papua"]));
  await tenantKv(env, "t-b")!.put("store-config:x", JSON.stringify(["aceh"]));
  await platformKv(env)!.put("store-config:x", "platform");
  assert.deepEqual([...kv.values.keys()].sort(), ["p:store-config:x", "t:t-a:store-config:x", "t:t-b:store-config:x"]);
  assert.deepEqual(await tenantKv(env, "t-a")!.get("store-config:x", "json"), ["papua"]);
  assert.deepEqual(await tenantKv(env, "t-b")!.get("store-config:x", "json"), ["aceh"]);
  await tenantKv(env, "t-a")!.delete("store-config:x");
  assert.equal(await tenantKv(env, "t-a")!.get("store-config:x"), null);
  assert.equal(await tenantKv(env, "t-b")!.get("store-config:x"), JSON.stringify(["aceh"]), "a delete stays in its tenant");
});

test("ISO-8: a cache key names tenant, version, host and path", () => {
  assert.equal(
    tenantCacheKey({ tenantId: "t-a", cacheVersion: 2 }, "Toko-A.adsbook.my.id", "/produk/x?q=1"),
    "https://cache.adsbook.id/t/t-a/v2/toko-a.adsbook.my.id/produk/x?q=1",
  );
  assert.throws(() => tenantCacheKey({ tenantId: "t/../b", cacheVersion: 1 }, "h", "/"), /invalid tenant id/);
});

test("ISO-6 through the routes: /assets serves each host its own tenant's object under one URL", async () => {
  const assetsRoute = await import("../pages/assets/[...key].ts");
  const bucket = fakeBucket();
  const key = "uploads/2026-11-16/0f3c.webp";
  await bucket.put(`t/t-a/${key}`, "bytes-of-a", { httpMetadata: { contentType: "image/webp" } });
  const get = (tenantId: string) =>
    assetsRoute.GET({
      params: { key },
      locals: { runtimeEnv: { ASSET_BUCKET: bucket }, tenantContext: { tenantId, cacheVersion: 1 } },
    } as never) as Promise<Response>;
  const own = await get("t-a");
  assert.equal(own.status, 200);
  assert.equal(await own.text(), "bytes-of-a");
  assert.equal((await get("t-b")).status, 404, "tenant B's host served tenant A's upload");
  const unresolved = (await assetsRoute.GET({ params: { key }, locals: { runtimeEnv: { ASSET_BUCKET: bucket } } } as never)) as Response;
  assert.equal(unresolved.status, 503, "no tenant, no storage");
});
