import type { APIRoute } from "astro";
import { jsonError, jsonOk } from "../../../../lib/api.ts";
import { tenantDatabase } from "../../../../lib/tenant-database.ts";
import { BUILT_IN_STOREFRONT_TEMPLATES, DEFAULT_STOREFRONT_TEMPLATE_ID } from "../../../../lib/storefront-template.ts";
import { checkAccent, DEFAULT_ACCENT, parseThemeSettingsInput, readThemeSettings } from "../../../../lib/storefront-theme.ts";

export const prerender = false;

/**
 * Admin › Tema (2026-11-23): the store's theme and its homepage settings.
 * Owner and admin, the roles that reach Pengaturan › Toko (auth.ts). Under
 * /api/admin/settings, so every 2xx write already ends the tenant's cached
 * storefront pages (edge-cache.ts STOREFRONT_WRITE_APIS).
 */
const THEMES = BUILT_IN_STOREFRONT_TEMPLATES.map((theme) => theme.id);

function database(locals: App.Locals) {
  const db = tenantDatabase(locals);
  return db && typeof db === "object" ? (db as D1Database) : null;
}

type StoreThemeRow = { id: number; storefront_template: string | null; theme_color: string | null; theme_settings: string | null };

async function read(db: D1Database) {
  const row = await db
    .prepare("SELECT id, storefront_template, theme_color, theme_settings FROM stores ORDER BY id LIMIT 1")
    .first<StoreThemeRow>();
  if (!row) return null;
  const active = THEMES.includes(row.storefront_template as (typeof THEMES)[number]) ? (row.storefront_template as string) : DEFAULT_STOREFRONT_TEMPLATE_ID;
  return {
    row,
    data: {
      active,
      // A store on a persisted runtime template keeps it; the cards then show
      // neither built-in as active.
      custom: Boolean(row.storefront_template && !THEMES.includes(row.storefront_template as (typeof THEMES)[number])),
      accent: (row.theme_color || DEFAULT_ACCENT).toUpperCase(),
      settings: readThemeSettings(row.theme_settings),
    },
  };
}

export const GET: APIRoute = async ({ locals }) => {
  const db = database(locals);
  if (!db) return jsonError("Database belum tersedia.", 503);
  try {
    const current = await read(db);
    if (!current) return jsonError("Toko belum disiapkan.", 404);
    return jsonOk({ data: current.data });
  } catch (error) {
    console.error("admin-theme-read", error instanceof Error ? error.message : "unknown");
    return jsonError("Pengaturan tema gagal dimuat.", 500);
  }
};

/**
 * `{ action: "activate", theme }` switches the theme; `{ action: "save",
 * accent, settings }` saves the homepage configuration. Each is validated in
 * full before one UPDATE; a refused value writes nothing.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const db = database(locals);
  if (!db) return jsonError("Database belum tersedia.", 503);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Payload tidak valid.", 400);
  try {
    const current = await read(db);
    if (!current) return jsonError("Toko belum disiapkan.", 404);

    if (body.action === "activate") {
      const theme = typeof body.theme === "string" ? body.theme : "";
      if (!THEMES.includes(theme as (typeof THEMES)[number])) return jsonError("Tema tidak dikenal.", 400);
      await db.prepare("UPDATE stores SET storefront_template = ? WHERE id = ?").bind(theme, current.row.id).run();
      const name = BUILT_IN_STOREFRONT_TEMPLATES.find((item) => item.id === theme)?.name ?? theme;
      return jsonOk({ message: `Tema ${name} aktif di toko Anda.`, data: (await read(db))!.data });
    }

    if (body.action === "save") {
      const accent = checkAccent(typeof body.accent === "string" ? body.accent : "");
      if (!accent.ok) return jsonError(accent.error, 400);
      const settings = parseThemeSettingsInput(body.settings);
      if (!settings.ok) return jsonError(settings.error, 400);
      await db
        .prepare("UPDATE stores SET theme_color = ?, theme_settings = ? WHERE id = ?")
        .bind(accent.accent === DEFAULT_ACCENT ? null : accent.accent, JSON.stringify(settings.settings), current.row.id)
        .run();
      return jsonOk({ message: "Pengaturan beranda tersimpan dan langsung tampil di toko.", data: (await read(db))!.data });
    }

    return jsonError("Aksi tema tidak valid.", 400);
  } catch (error) {
    console.error("admin-theme-write", error instanceof Error ? error.message : "unknown");
    return jsonError("Pengaturan tema gagal disimpan.", 500);
  }
};
