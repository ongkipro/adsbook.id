// Admin › Tema API against the real migration chain: 0086 moves the default
// theme, a write is validated in full, and a refused value writes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { splitMigrationStatements } from "./schema-version.ts";
import { GET, POST } from "../pages/api/admin/settings/theme.ts";
import { DEFAULT_THEME_SETTINGS } from "./storefront-theme.ts";

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
  const setRaw = (json: string) => sqlite.prepare("UPDATE stores SET theme_settings = ? WHERE id = 1").run(json);
  return { row, post, get, setRaw };
}

test("0086 + 0087: every store ends on Compact (the 480px column); a custom runtime template is kept", () => {
  assert.equal(store("compact-market").row().storefront_template, "compact-market");
  assert.equal(store(null).row().storefront_template, "compact-market");
  assert.equal(store("pasar-rapi", "0087").row().storefront_template, "compact-market", "a store that held the withdrawn wide theme moves back");
  assert.equal(store("katalog-saya").row().storefront_template, "katalog-saya");
});

test("Tema API: Compact is active, only a built-in theme can be activated", async () => {
  const theme = store();
  assert.deepEqual((await theme.get()).data, {
    active: "compact-market",
    custom: false,
    accent: "#2563EB",
    settings: DEFAULT_THEME_SETTINGS,
  });
  assert.equal((await theme.post({ action: "activate", theme: "compact-market" })).status, 200);
  assert.equal((await theme.post({ action: "activate", theme: "pasar-rapi" })).status, 400, "the withdrawn wide theme cannot come back through the API");
  assert.equal(theme.row().storefront_template, "compact-market");
  const custom = store("katalog-saya");
  assert.equal((await custom.get()).data.custom, true);
});

test("Tema API: a save stores accent and settings together; a refused value writes neither", async () => {
  const theme = store();
  const settings = structuredClone(DEFAULT_THEME_SETTINGS);
  settings.sections.hero.enabled = false;
  settings.sections.catalog.title = "Madu pilihan";
  settings.sections.catalog.description = "";
  settings.order = ["hero", "catalog", "trust", "featured", "announcement", "howToOrder"];
  const saved = await theme.post({ action: "save", accent: "#0f766e", settings });
  assert.equal(saved.status, 200);
  assert.deepEqual(theme.row(), { storefront_template: "compact-market", theme_color: "#0F766E", theme_settings: JSON.stringify(settings) });

  const tooLight = await theme.post({ action: "save", accent: "#FACC15", settings: { ...settings, sections: { ...settings.sections, catalog: { ...settings.sections.catalog, title: "Lain" } } } });
  assert.equal(tooLight.status, 400);
  assert.match(tooLight.payload.error!, /terlalu terang/);
  const markup = await theme.post({ action: "save", accent: "#0F766E", settings: { ...settings, sections: { ...settings.sections, catalog: { ...settings.sections.catalog, title: "<img src=x>" } } } });
  assert.equal(markup.status, 400);
  assert.deepEqual(theme.row(), { storefront_template: "compact-market", theme_color: "#0F766E", theme_settings: JSON.stringify(settings) }, "both refusals wrote nothing");

  // The default blue is stored as "not set", so the stylesheet's own value stands.
  await theme.post({ action: "save", accent: "#2563EB", settings });
  assert.equal(theme.row().theme_color, null);
  assert.equal((await theme.post({ action: "nope" })).status, 400);
});

test("Tema API: a store saved in the v1 shape reads as v2 with its choices kept, and a v1 write is refused", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const theme = store();
  const v1 = { sections: { banner: false, trustStrip: false }, catalog: { title: "Madu pilihan", description: "Asli dari hutan." } };
  theme.setRaw(JSON.stringify(v1));
  const read = (await theme.get()).data.settings as typeof DEFAULT_THEME_SETTINGS;
  assert.equal(read.version, 2);
  assert.equal(read.sections.hero.enabled, false);
  assert.equal(read.sections.trust.enabled, false);
  assert.equal(read.sections.catalog.title, "Madu pilihan");
  assert.equal(read.sections.catalog.description, "Asli dari hutan.");
  assert.equal((await theme.post({ action: "save", accent: "#2563EB", settings: v1 })).status, 400, "writes are v2 only");
});
