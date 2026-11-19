import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PUT } from "../pages/api/admin/content.ts";

// R1a: every write to a storefront_content row names the version its editor
// loaded. 0 creates a missing row and nothing else; a positive version updates
// only the row still at that version; every successful write bumps it.

const migration0012 = readFileSync(new URL("../db/migrations/0012_smart_overlord.sql", import.meta.url), "utf8");

function tenantStore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO stores (id, name) VALUES (1, 'Toko Uji');
    CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT, slug TEXT, category TEXT, image_url TEXT, is_active INTEGER);
    CREATE TABLE product_variants (id INTEGER PRIMARY KEY, product_id INTEGER, sku TEXT, title TEXT, price INTEGER,
      compare_price INTEGER, weight_grams INTEGER, stock INTEGER);
  `);
  sqlite.exec(migration0012);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>() {
      return (sqlite.prepare(sql).get(...(args as never[])) ?? null) as T | null;
    },
    async all<T>() {
      return { results: sqlite.prepare(sql).all(...(args as never[])) as T[] };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    async batch(list: Array<ReturnType<typeof statement>>) {
      return Promise.all(list.map((item) => item.all()));
    },
  } as unknown as D1Database;
  const row = (key = "home") =>
    sqlite
      .prepare("SELECT version, draft_json, published_json, generated_by FROM storefront_content WHERE content_key = ?")
      .get(key) as { version: number; draft_json: string | null; published_json: string | null; generated_by: string } | undefined;
  return { d1, row, sqlite };
}

/** PLATFORM_DB as far as the AI cap reads it: a plan with room, and a count of cap spends. */
function platformStub() {
  const spends = { count: 0 };
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    async first() {
      if (sql.includes("FROM tenants")) {
        return { id: "starter", max_custom_domains: 1, media_uploads_per_hour: 20, ai_generations_per_hour: 20 };
      }
      if (sql.includes("INSERT INTO rate_limits")) {
        spends.count += 1;
        return { count: spends.count };
      }
      return null;
    },
  });
  return { db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database, spends };
}

const home = (catalogTitle: string) => ({
  hero: { title: "Toko Uji", description: "Belanja produk pilihan.", ratingLabel: "Diproses setiap hari" },
  catalog: { eyebrow: "Produk", title: catalogTitle, description: "Semua produk siap kirim." },
  solutionsHeading: { eyebrow: "Halaman", title: "Selengkapnya", description: "Halaman aktif." },
  proofsHeading: { eyebrow: "Ulasan", title: "Kata Pembeli", description: "Cerita pembeli." },
  heroHighlights: [{ label: "Siap kirim", icon: "package" }],
  heroSlides: [],
  solutions: [],
  proofs: [],
});

type Locals = Record<string, unknown>;

async function put(locals: Locals, body: Record<string, unknown>) {
  const response = await PUT({
    request: new Request("https://toko.test/api/admin/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals,
  } as never);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const ownerLocals = (d1: D1Database, extra: Locals = {}): Locals => ({
  tenantDb: d1,
  admin: { username: "owner@toko.test", role: "owner" },
  ...extra,
});

test("a write without expectedVersion is refused with 428 and changes nothing", async () => {
  const { d1, row } = tenantStore();
  const locals = ownerLocals(d1);
  for (const action of ["save-draft", "publish", "generate"]) {
    const result = await put(locals, { action, key: "home", content: home("A") });
    assert.equal(result.status, 428, action);
    assert.equal(result.body.code, "CONTENT_VERSION_REQUIRED");
  }
  for (const bad of [-1, 1.5, "1", null]) {
    const result = await put(locals, { action: "save-draft", key: "home", content: home("A"), expectedVersion: bad });
    assert.equal(result.status, 428, String(bad));
  }
  assert.equal(row(), undefined);
});

test("version 0 creates a missing row once; the competing first create is a conflict", async () => {
  const { d1, row } = tenantStore();
  const locals = ownerLocals(d1);
  const [first, second] = await Promise.all([
    put(locals, { action: "save-draft", key: "home", content: home("Editor A"), expectedVersion: 0 }),
    put(locals, { action: "save-draft", key: "home", content: home("Editor B"), expectedVersion: 0 }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const winner = first.status === 200 ? "Editor A" : "Editor B";
  const loser = first.status === 200 ? second : first;
  assert.equal(loser.body.code, "CONTENT_VERSION_CONFLICT");
  assert.equal(loser.body.currentVersion, 1);
  assert.equal(row()?.version, 1);
  assert.equal(JSON.parse(row()!.draft_json!).catalog.title, winner);
  // Version 0 never overwrites an existing row, however many times it is sent.
  const again = await put(locals, { action: "save-draft", key: "home", content: home("Late create"), expectedVersion: 0 });
  assert.equal(again.status, 409);
  assert.equal(JSON.parse(row()!.draft_json!).catalog.title, winner);
});

test("a stale save is refused and the newer draft survives; a fresh one bumps the version", async () => {
  const { d1, row } = tenantStore();
  const locals = ownerLocals(d1);
  await put(locals, { action: "save-draft", key: "home", content: home("v1"), expectedVersion: 0 });
  // Two editors load v1; the JSON editor saves first.
  const jsonEditor = await put(locals, { action: "save-draft", key: "home", content: home("JSON editor"), expectedVersion: 1 });
  assert.equal(jsonEditor.status, 200);
  assert.equal(jsonEditor.body.data.version, 2);
  const stale = await put(locals, { action: "save-draft", key: "home", content: home("Stale tab"), expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentVersion, 2);
  assert.equal(row()?.version, 2);
  assert.equal(JSON.parse(row()!.draft_json!).catalog.title, "JSON editor");
});

test("a positive version never recreates a missing row", async () => {
  const { d1, row, sqlite } = tenantStore();
  const locals = ownerLocals(d1);
  await put(locals, { action: "save-draft", key: "home", content: home("v1"), expectedVersion: 0 });
  sqlite.exec("DELETE FROM storefront_content WHERE content_key = 'home'");
  for (const action of ["save-draft", "publish"]) {
    const result = await put(locals, { action, key: "home", content: home("Ghost"), expectedVersion: 1 });
    assert.equal(result.status, 409, action);
    assert.equal(result.body.currentVersion, null);
    assert.equal(row(), undefined, action);
  }
});

test("publish bumps the version and refuses a draft its editor did not load", async () => {
  const { d1, row } = tenantStore();
  const locals = ownerLocals(d1);
  await put(locals, { action: "save-draft", key: "home", content: home("Reviewed"), expectedVersion: 0 });
  const published = await put(locals, { action: "publish", key: "home", expectedVersion: 1 });
  assert.equal(published.status, 200);
  assert.equal(published.body.data.version, 2);
  assert.equal(row()?.version, 2);
  assert.equal(JSON.parse(row()!.published_json!).catalog.title, "Reviewed");
  // Someone saves a new draft (v3); a publish from the tab that saw v2 must not ship it.
  await put(locals, { action: "save-draft", key: "home", content: home("Not reviewed"), expectedVersion: 2 });
  const stalePublish = await put(locals, { action: "publish", key: "home", expectedVersion: 2 });
  assert.equal(stalePublish.status, 409);
  assert.equal(stalePublish.body.currentVersion, 3);
  assert.equal(JSON.parse(row()!.published_json!).catalog.title, "Reviewed");
  // Version 0 has nothing to publish onto: 400 without a row, 409 with one.
  assert.equal((await put(locals, { action: "publish", key: "home", expectedVersion: 0 })).status, 409);
  assert.equal((await put(locals, { action: "publish", key: "product:7", expectedVersion: 0 })).status, 400);
});

test("product keys follow the same contract", async () => {
  const { d1, row } = tenantStore();
  const locals = ownerLocals(d1);
  const product = {
    contentName: "Produk Uji", headline: "Produk uji", subheadline: "Sub", seoTitle: "SEO", seoDescription: "Deskripsi SEO",
    image: "/media/a.webp", heroImage: "/media/a.webp", tag: "Tag", relatedCategories: ["Kategori"], description: "Deskripsi",
    benefits: ["Manfaat"], keyPoints: ["Poin"], idealFor: ["Pembeli"], offerText: "Penawaran", ctaText: "Pesan", reviews: [],
  };
  assert.equal((await put(locals, { action: "save-draft", key: "product:7", content: product })).status, 428);
  assert.equal((await put(locals, { action: "save-draft", key: "product:7", content: product, expectedVersion: 0 })).status, 200);
  assert.equal((await put(locals, { action: "save-draft", key: "product:7", content: product, expectedVersion: 5 })).status, 409);
  assert.equal(row("product:7")?.version, 1);
});

test("generate on a stale editor is refused before the AI cap is spent or the model runs", async () => {
  const { d1, row } = tenantStore();
  const platform = platformStub();
  let modelRuns = 0;
  const locals = ownerLocals(d1, {
    billing: { state: "subscribed" },
    tenantContext: { tenantId: "tenant-a" },
    runtimeEnv: { PLATFORM_DB: platform.db, AI: { run: async () => { modelRuns += 1; return { response: JSON.stringify(home("AI")) }; } } },
  });
  await put(locals, { action: "save-draft", key: "home", content: home("v1"), expectedVersion: 0 });
  const stale = await put(locals, { action: "generate", key: "home", expectedVersion: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentVersion, 1);
  assert.equal(platform.spends.count, 0);
  assert.equal(modelRuns, 0);
  // A current editor generates normally; the result is a new version written by the model.
  const fresh = await put(locals, { action: "generate", key: "home", expectedVersion: 1 });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.data.version, 2);
  assert.equal(row()?.generated_by, "workers-ai");
  assert.equal(JSON.parse(row()!.draft_json!).catalog.title, "AI");
});

test("a save that lands while the model runs wins; the generated draft is discarded", async () => {
  const { d1, row } = tenantStore();
  const platform = platformStub();
  const base = ownerLocals(d1);
  await put(base, { action: "save-draft", key: "home", content: home("v1"), expectedVersion: 0 });
  const locals = ownerLocals(d1, {
    billing: { state: "subscribed" },
    tenantContext: { tenantId: "tenant-a" },
    runtimeEnv: {
      PLATFORM_DB: platform.db,
      AI: {
        run: async () => {
          // Another editor saves v2 while the model is still writing.
          const competing = await put(base, { action: "save-draft", key: "home", content: home("Saved during AI"), expectedVersion: 1 });
          assert.equal(competing.status, 200);
          return { response: JSON.stringify(home("AI result")) };
        },
      },
    },
  });
  const generated = await put(locals, { action: "generate", key: "home", expectedVersion: 1 });
  assert.equal(generated.status, 409);
  assert.equal(generated.body.currentVersion, 2);
  assert.equal(platform.spends.count, 1, "the cap was spent before the model ran");
  assert.equal(row()?.version, 2);
  assert.equal(row()?.generated_by, "manual");
  assert.equal(JSON.parse(row()!.draft_json!).catalog.title, "Saved during AI");
});

test("generate keeps the billing rule: a Preview store gets 402 and nothing is written", async () => {
  const { d1, row } = tenantStore();
  const platform = platformStub();
  let modelRuns = 0;
  const locals = ownerLocals(d1, {
    billing: { state: "preview" },
    tenantContext: { tenantId: "tenant-a" },
    runtimeEnv: { PLATFORM_DB: platform.db, AI: { run: async () => { modelRuns += 1; return {}; } } },
  });
  const result = await put(locals, { action: "generate", key: "home", expectedVersion: 0 });
  assert.equal(result.status, 402);
  assert.equal(platform.spends.count, 0);
  assert.equal(modelRuns, 0);
  assert.equal(row(), undefined);
});
