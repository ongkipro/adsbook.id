// Admin › Tema API against the real migration chain: 0086 moves the default
// theme, a write is validated in full, and a refused value writes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { splitMigrationStatements } from "./schema-version.ts";
import { GET, POST } from "../pages/api/admin/settings/theme.ts";

function store(template: string | null = "compact-market", stop = "0086") {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../db/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
  const run = (name: string) => {
    for (const statement of splitMigrationStatements(readFileSync(new URL(name, dir), "utf8"))) sqlite.exec(statement);
  };
  // The store exists before 0086, as on every live tenant.
  for (const name of files.filter((file) => file < stop)) run(name);
  sqlite.prepare("INSERT INTO stores (id, name, slug, created_at, storefront_template) VALUES (1, 'Toko', 'toko', '2026-01-01', ?)").run(template);
  for (const name of files.filter((file) => file >= stop)) run(name);
  const database = {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => { bound.push(...values); return statement; },
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(bound as never[])).changes) } }),
        first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...(bound as never[])) }),
      };
      return statement;
    },
  } as unknown as D1Database;
  const row = () => ({ ...(sqlite.prepare("SELECT storefront_template, theme_color, theme_settings FROM stores WHERE id = 1").get() as object) }) as Record<string, string | null>;
  const locals = { admin: { username: "u", role: "owner", mustChangePassword: false }, tenantDb: database, runtimeEnv: { OMS_DB: database } };
  const post = async (body: unknown) => {
    const response = await POST({ request: new Request("https://toko.test/api/admin/settings/theme", { method: "POST", body: JSON.stringify(body) }), locals } as never);
    return { status: response.status, payload: (await response.json()) as { success: boolean; error?: string; data?: Record<string, unknown> } };
  };
  const get = async () => (await (await GET({ locals } as never)).json()) as { data: Record<string, unknown> };
  return { row, post, get };
}

test("0086: a store on the old default moves to Pasar Rapi; a store on a custom template keeps it", () => {
  assert.equal(store("compact-market").row().storefront_template, "pasar-rapi");
  assert.equal(store(null).row().storefront_template, "pasar-rapi");
  assert.equal(store("katalog-saya").row().storefront_template, "katalog-saya");
});

test("Tema API: read the active theme, switch it, and refuse an unknown one", async () => {
  const theme = store();
  assert.deepEqual((await theme.get()).data, {
    active: "pasar-rapi",
    custom: false,
    accent: "#2563EB",
    settings: { sections: { banner: true, trustStrip: true }, catalog: { title: "Produk pilihan", description: "Pilih produk, cek varian dan harga, lalu pesan langsung dari halamannya." } },
  });
  const switched = await theme.post({ action: "activate", theme: "compact-market" });
  assert.equal(switched.status, 200);
  assert.equal(theme.row().storefront_template, "compact-market");
  assert.equal((await theme.post({ action: "activate", theme: "wide-catalog" })).status, 400);
  assert.equal(theme.row().storefront_template, "compact-market", "nothing written");
  assert.equal(store("katalog-saya").row().storefront_template, "katalog-saya");
  assert.equal((await store("katalog-saya").get()).data.custom, true);
});

test("Tema API: a save stores accent and settings together; a refused value writes neither", async () => {
  const theme = store();
  const settings = { sections: { banner: false, trustStrip: true }, catalog: { title: "Madu pilihan", description: "" } };
  const saved = await theme.post({ action: "save", accent: "#0f766e", settings });
  assert.equal(saved.status, 200);
  assert.deepEqual(theme.row(), { storefront_template: "pasar-rapi", theme_color: "#0F766E", theme_settings: JSON.stringify(settings) });

  const tooLight = await theme.post({ action: "save", accent: "#FACC15", settings: { ...settings, catalog: { title: "Lain", description: "" } } });
  assert.equal(tooLight.status, 400);
  assert.match(tooLight.payload.error!, /terlalu terang/);
  const markup = await theme.post({ action: "save", accent: "#0F766E", settings: { ...settings, catalog: { title: "<img src=x>", description: "" } } });
  assert.equal(markup.status, 400);
  assert.deepEqual(theme.row(), { storefront_template: "pasar-rapi", theme_color: "#0F766E", theme_settings: JSON.stringify(settings) }, "both refusals wrote nothing");

  // The default blue is stored as "not set", so the stylesheet's own value stands.
  await theme.post({ action: "save", accent: "#2563EB", settings });
  assert.equal(theme.row().theme_color, null);
  assert.equal((await theme.post({ action: "nope" })).status, 400);
});
