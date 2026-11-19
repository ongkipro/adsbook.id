import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PUT } from "../pages/api/admin/content.ts";
import { projectPublishedBanner, type HomeContent } from "./storefront-content.ts";
import { decideBannerPreview, seedHomeContent } from "./tenant-content.ts";

// R1b: slot-0 banner operations on the draft or the published home document,
// under the R1a version contract, and the preview that renders the exact
// projection a publish stores. No AI binding and a Preview-mode store
// throughout: the manual flow needs neither.

const migration0012 = readFileSync(new URL("../db/migrations/0012_smart_overlord.sql", import.meta.url), "utf8");
const tenant = { name: "Toko Uji", tagline: "", description: "" } as App.Locals["tenant"];
const seed = seedHomeContent(tenant);

function tenantStore() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO stores (id, name) VALUES (1, 'Toko Uji');");
  sqlite.exec(migration0012);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>() {
      return (sqlite.prepare(sql).get(...(args as never[])) ?? null) as T | null;
    },
    async run() {
      return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } };
    },
  });
  const d1 = { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
  const row = () =>
    sqlite.prepare("SELECT version, draft_json, published_json, generated_by FROM storefront_content WHERE content_key = 'home'").get() as
      | { version: number; draft_json: string | null; published_json: string | null; generated_by: string }
      | undefined;
  /** A row in a given state, written directly (the divergent states the editors can reach). */
  const seedRow = (version: number, draft: HomeContent | null, published: HomeContent | null | string) =>
    sqlite
      .prepare("INSERT INTO storefront_content (store_id, content_key, content_type, draft_json, published_json, version, generated_by, updated_at) VALUES (1, 'home', 'home', ?, ?, ?, 'manual', 'x')")
      .run(draft ? JSON.stringify(draft) : null, typeof published === "string" ? published : published ? JSON.stringify(published) : null, version);
  return { d1, row, seedRow, sqlite };
}

const slide = (name: string) => ({ image: `/media/content/2026-11/${name}.webp`, alt: `Alt ${name}`, badge: "Toko Uji", text: `Teks ${name}` });
const [S, D, Y, Y2, Z] = ["S", "D", "Y", "Y2", "Z"].map(slide);
const homeWith = (slides: ReturnType<typeof slide>[], catalogTitle = "Pilih Sesuai Kebutuhan"): HomeContent => ({
  ...seed,
  catalog: { ...seed.catalog, title: catalogTitle },
  heroSlides: slides,
});

const locals = (d1: D1Database, role = "advertiser") => ({
  tenantDb: d1,
  tenant,
  admin: { username: "user@toko.test", role },
  billing: { state: "preview" },
  runtimeEnv: {},
});

async function banner(d1: D1Database, body: Record<string, unknown>) {
  const response = await PUT({
    request: new Request("https://toko.test/api/admin/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "banner", key: "home", ...body }),
    }),
    locals: locals(d1),
  } as never);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const parsed = (json: string | null | undefined) => (json ? (JSON.parse(json) as HomeContent) : null);

test("version 0 creates the row with a draft banner only; competing first creates conflict", async () => {
  const { d1, row } = tenantStore();
  const [first, second] = await Promise.all([
    banner(d1, { target: "draft", op: "insert-first", slide: D, expectedVersion: 0 }),
    banner(d1, { target: "draft", op: "insert-first", slide: S, expectedVersion: 0 }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(row()?.version, 1);
  assert.equal(row()?.generated_by, "manual");
  assert.equal(row()?.published_json, null);
  assert.equal(parsed(row()?.draft_json)!.heroSlides.length, 1);
  assert.deepEqual(parsed(row()?.draft_json)!.solutions, []);
});

test("version 0 never replaces, removes or publishes", async () => {
  const { d1, row } = tenantStore();
  const replace = await banner(d1, { target: "draft", op: "replace-first", slide: D, expectedVersion: 0 });
  assert.equal(replace.status, 422);
  assert.equal(replace.body.reason, "draft_empty");
  assert.equal((await banner(d1, { target: "published", op: "insert-first", expectedVersion: 0 })).status, 400);
  assert.equal(row(), undefined);
});

test("stale or missing rows are 409 and nothing is written or recreated", async () => {
  const { d1, row, seedRow, sqlite } = tenantStore();
  seedRow(3, homeWith([D]), homeWith([S]));
  const before = JSON.stringify(row());
  for (const version of [2, 4]) {
    const result = await banner(d1, { target: "published", op: "replace-first", expectedVersion: version });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CONTENT_VERSION_CONFLICT");
    assert.equal(result.body.currentVersion, 3);
  }
  assert.equal(JSON.stringify(row()), before);
  sqlite.exec("DELETE FROM storefront_content");
  const gone = await banner(d1, { target: "draft", op: "insert-first", slide: D, expectedVersion: 3 });
  assert.equal(gone.status, 409);
  assert.equal(gone.body.currentVersion, null);
  assert.equal(row(), undefined);
});

test("the first publish starts from the seed, takes the draft's slot 0, and leaves the draft alone", async () => {
  const { d1, row, seedRow } = tenantStore();
  seedRow(1, homeWith([D, Y], "Draft JSON belum siap"), null);
  const draftBefore = row()?.draft_json;
  const result = await banner(d1, { target: "published", op: "insert-first", expectedVersion: 1 });
  assert.equal(result.status, 200);
  assert.equal(row()?.version, 2);
  assert.equal(row()?.draft_json, draftBefore);
  const published = parsed(row()?.published_json)!;
  assert.deepEqual(published.heroSlides, [D]);
  assert.equal(published.catalog.title, seed.catalog.title, "the draft's other edits stay unpublished");
  assert.deepEqual(published.solutions, []);
});

test("published operations when draft and published differ: only slot 0 changes, from the draft", async () => {
  const cases: Array<[string, HomeContent, HomeContent, "insert-first" | "replace-first" | "remove-first", ReturnType<typeof slide>[]]> = [
    ["replace", homeWith([D, Y]), homeWith([S, Y]), "replace-first", [D, Y]],
    ["insert", homeWith([D, S, Y]), homeWith([S, Y]), "insert-first", [D, S, Y]],
    ["remove when lists differ", homeWith([Y, Z]), homeWith([S, Y, Z]), "remove-first", [Y, Z]],
    ["unpublished edit of slide 2 stays draft", homeWith([D, Y2]), homeWith([S, Y]), "replace-first", [D, Y]],
    ["remove the only banner", homeWith([]), homeWith([S]), "remove-first", []],
  ];
  for (const [name, draft, published, op, expected] of cases) {
    const { d1, row, seedRow } = tenantStore();
    seedRow(5, draft, published);
    const result = await banner(d1, { target: "published", op, expectedVersion: 5 });
    assert.equal(result.status, 200, name);
    assert.deepEqual(parsed(row()?.published_json)!.heroSlides, expected, name);
    assert.deepEqual(parsed(row()?.draft_json), draft, `${name}: draft untouched`);
  }
});

test("a banner publish never publishes the draft's other fields", async () => {
  const { d1, row, seedRow } = tenantStore();
  seedRow(2, homeWith([D], "Draft JSON belum siap"), homeWith([S], "Lama"));
  assert.equal((await banner(d1, { target: "published", op: "replace-first", expectedVersion: 2 })).status, 200);
  assert.equal(parsed(row()?.published_json)!.catalog.title, "Lama");
  assert.equal(parsed(row()?.draft_json)!.catalog.title, "Draft JSON belum siap");
});

test("draft operations change only the draft's slot 0", async () => {
  const { d1, row, seedRow } = tenantStore();
  seedRow(1, homeWith([S, Y], "Draft title"), homeWith([S, Y]));
  const publishedBefore = row()?.published_json;
  assert.equal((await banner(d1, { target: "draft", op: "replace-first", slide: D, expectedVersion: 1 })).status, 200);
  assert.deepEqual(parsed(row()?.draft_json)!.heroSlides, [D, Y]);
  assert.equal(parsed(row()?.draft_json)!.catalog.title, "Draft title");
  assert.equal((await banner(d1, { target: "draft", op: "remove-first", expectedVersion: 2 })).status, 200);
  assert.deepEqual(parsed(row()?.draft_json)!.heroSlides, [Y]);
  assert.equal(row()?.published_json, publishedBefore);
  assert.equal(row()?.version, 3);
});

test("preconditions and stored-document problems are 422 and write nothing", async () => {
  const { d1, row, seedRow, sqlite } = tenantStore();
  seedRow(1, homeWith([]), homeWith([S]));
  const before = JSON.stringify(row());
  const empty = await banner(d1, { target: "published", op: "replace-first", expectedVersion: 1 });
  assert.equal(empty.status, 422);
  assert.deepEqual([empty.body.code, empty.body.reason], ["BANNER_PRECONDITION_FAILED", "draft_empty"]);
  assert.equal(JSON.stringify(row()), before);

  sqlite.exec("DELETE FROM storefront_content");
  seedRow(1, homeWith([D]), homeWith(Array.from({ length: 10 }, (_, index) => slide(`F${index}`))));
  const full = await banner(d1, { target: "published", op: "insert-first", expectedVersion: 1 });
  assert.deepEqual([full.status, full.body.reason], [422, "slots_full"]);

  sqlite.exec("DELETE FROM storefront_content");
  seedRow(1, homeWith([D]), '{"hero":"rusak"}');
  const invalid = await banner(d1, { target: "published", op: "replace-first", expectedVersion: 1 });
  assert.deepEqual([invalid.status, invalid.body.code], [422, "PUBLISHED_CONTENT_INVALID"]);
  assert.equal(row()?.published_json, '{"hero":"rusak"}');
});

test("malformed banner requests are refused before anything is read", async () => {
  const { d1, seedRow } = tenantStore();
  seedRow(1, homeWith([D]), homeWith([S]));
  assert.equal((await banner(d1, { target: "draft", op: "insert-first", slide: D })).status, 428);
  assert.equal((await banner(d1, { target: "published", op: "insert-first", slide: D, expectedVersion: 1 })).status, 400, "publish takes the draft's slide");
  assert.equal((await banner(d1, { key: "product:1", target: "draft", op: "insert-first", slide: D, expectedVersion: 1 })).status, 400);
  assert.equal((await banner(d1, { target: "draft", op: "shuffle", slide: D, expectedVersion: 1 })).status, 400);
  const external = await banner(d1, { target: "draft", op: "insert-first", slide: { ...D, image: "https://contoh.test/a.webp" }, expectedVersion: 1 });
  assert.equal(external.status, 400, "a banner image comes from this store's media");
});

test("the preview renders exactly what the publish stores", async () => {
  for (const [draft, published, op] of [
    [homeWith([D, Y]), homeWith([S, Y]), "replace-first"],
    [homeWith([Y, Z]), homeWith([S, Y, Z]), "remove-first"],
    [homeWith([D]), null, "insert-first"],
  ] as const) {
    const { d1, row, seedRow } = tenantStore();
    seedRow(7, draft, published);
    const preview = decideBannerPreview({ session: { role: "owner", mustChangePassword: false }, op, version: "7", row: row()!, seed });
    assert.equal(preview.granted, true);
    assert.equal((await banner(d1, { target: "published", op, expectedVersion: 7 })).status, 200);
    assert.deepEqual(preview.granted && preview.published, parsed(row()?.published_json), op);
  }
});

test("the preview is granted only to roles that may open the content tools, and discloses nothing otherwise", () => {
  const stored = { version: 4, draft_json: JSON.stringify(homeWith([D])), published_json: JSON.stringify(homeWith([S])) };
  const decide = (session: Parameters<typeof decideBannerPreview>[0]["session"], version = "4", op = "replace-first") =>
    decideBannerPreview({ session, op, version, row: stored, seed });
  for (const role of ["owner", "admin", "advertiser"] as const) {
    const granted = decide({ role, mustChangePassword: false });
    assert.equal(granted.granted, true, role);
    assert.deepEqual(granted.granted && granted.published?.heroSlides, [D], role);
  }
  assert.deepEqual(decide({ role: "customer_service", mustChangePassword: false }), { granted: false });
  assert.deepEqual(decide({ role: "owner", mustChangePassword: true }), { granted: false });
  assert.deepEqual(decide(null), { granted: false });
  const stale = decide({ role: "owner", mustChangePassword: false }, "3");
  assert.deepEqual([stale.granted, stale.granted && stale.published], [true, null]);
  const refused = decideBannerPreview({ session: { role: "owner", mustChangePassword: false }, op: "remove-first", version: "4", row: { ...stored, published_json: JSON.stringify(homeWith([])) }, seed });
  assert.equal(refused.granted && refused.published, null);
  assert.match(refused.granted ? refused.notice ?? "" : "", /Belum ada banner/);
});

test("projectPublishedBanner reads the draft's slot 0, never anything else", () => {
  const row = { draft_json: JSON.stringify(homeWith([D, Y2], "Draft")), published_json: JSON.stringify(homeWith([S, Y], "Terbit")) };
  const result = projectPublishedBanner(row, "replace-first", seed);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.content.heroSlides, [D, Y]);
  assert.equal(result.ok && result.content.catalog.title, "Terbit");
});
