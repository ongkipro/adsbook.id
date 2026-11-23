import { z } from "zod";

/**
 * Admin "Tema" (2026-11-23): what a store configures for its homepage, on top
 * of the theme it picked (`stores.storefront_template`). Stored as JSON in
 * `stores.theme_settings` (migration 0086); NULL or anything that fails this
 * schema reads as the defaults, so a bad row never takes the storefront down.
 * The banner lives in `storefront_content` 'home' (R1b) and the accent in
 * `stores.theme_color`; this holds only switches and the catalogue heading.
 */
export const storeThemeSettingsSchema = z
  .object({
    sections: z
      .object({
        banner: z.boolean(),
        trustStrip: z.boolean(),
      })
      .strict(),
    catalog: z
      .object({
        title: z.string().trim().min(2).max(60),
        description: z.string().trim().max(160),
      })
      .strict(),
  })
  .strict();

export type StoreThemeSettings = z.infer<typeof storeThemeSettingsSchema>;

export const DEFAULT_THEME_SETTINGS: StoreThemeSettings = Object.freeze({
  sections: Object.freeze({ banner: true, trustStrip: true }),
  catalog: Object.freeze({
    title: "Produk pilihan",
    description: "Pilih produk, cek varian dan harga, lalu pesan langsung dari halamannya.",
  }),
}) as StoreThemeSettings;

/** The stored JSON, or the defaults when it is absent or invalid (logged, never thrown). */
export function readThemeSettings(stored: string | null | undefined): StoreThemeSettings {
  if (!stored) return DEFAULT_THEME_SETTINGS;
  try {
    return storeThemeSettingsSchema.parse(JSON.parse(stored));
  } catch (error) {
    console.error("storefront-theme-settings-invalid", error instanceof Error ? error.message : "unknown");
    return DEFAULT_THEME_SETTINGS;
  }
}

/** Validates a settings write; HTML-looking text is refused rather than escaped twice. */
export function parseThemeSettingsInput(value: unknown): { ok: true; settings: StoreThemeSettings } | { ok: false; error: string } {
  const parsed = storeThemeSettingsSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "";
    if (field === "catalog.title") return { ok: false, error: "Judul katalog 2–60 karakter." };
    if (field === "catalog.description") return { ok: false, error: "Deskripsi katalog maksimal 160 karakter." };
    return { ok: false, error: "Pengaturan tema tidak valid." };
  }
  const { title, description } = parsed.data.catalog;
  if (/[<>]/.test(title) || /[<>]/.test(description)) return { ok: false, error: "Judul dan deskripsi tidak boleh berisi tanda < atau >." };
  return { ok: true, settings: parsed.data };
}

// ── Accent colour (UI-2) ─────────────────────────────────────────────────────

export const DEFAULT_ACCENT = "#2563EB";
const HEX = /^#[0-9a-f]{6}$/i;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function mix(hex: string, toward: string, amount: number): string {
  const from = channels(hex);
  const to = channels(toward);
  return `#${from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * UI-2: white button text on the accent must reach 4.5:1. A colour that does
 * not is refused at save, with the reason, rather than quietly darkened: the
 * seller sees exactly the colour the buyer will.
 */
export function checkAccent(value: string): { ok: true; accent: string } | { ok: false; error: string } {
  const accent = value.trim();
  if (!HEX.test(accent)) return { ok: false, error: "Warna harus berformat heksadesimal enam digit, contoh: #2563EB." };
  const ratio = contrastRatio(accent, "#ffffff");
  if (ratio < 4.5) {
    return { ok: false, error: `Warna ini terlalu terang untuk tombol bertulisan putih (kontras ${ratio.toFixed(1)}:1, minimal 4,5:1). Pilih warna yang lebih gelap.` };
  }
  return { ok: true, accent: accent.toUpperCase() };
}

/**
 * The `--sf-*` tokens for an accent (ADR-019: a store re-brands through these
 * tokens, never a call site). Empty for the default, so the stylesheet's own
 * values stand. An accent that fails UI-2 also yields nothing: an old row is
 * never allowed to render an unreadable button.
 */
export function accentTokens(themeColor: string | null | undefined): string {
  const accent = (themeColor ?? "").trim();
  if (!HEX.test(accent) || accent.toUpperCase() === DEFAULT_ACCENT) return "";
  if (contrastRatio(accent, "#ffffff") < 4.5) return "";
  const strong = mix(accent, "#000000", 0.18);
  const soft = mix(accent, "#ffffff", 0.92);
  const [r, g, b] = channels(accent);
  // Both names: --sf-brand-* reaches the checkout form, which declares its own
  // --sf-accent from it; --sf-accent serves every other storefront call site.
  const ring = `rgba(${r}, ${g}, ${b}, 0.28)`;
  return `--sf-accent:${accent};--sf-accent-strong:${strong};--sf-accent-soft:${soft};--sf-accent-ring:${ring};--sf-brand-accent:${accent};--sf-brand-accent-strong:${strong};--sf-brand-accent-soft:${soft};--sf-brand-accent-ring:${ring};`;
}

/**
 * The store's homepage settings, read on the storefront pages that use them
 * (not in the per-request identity read, so a store mid-migration still
 * resolves). Any failure reads as the defaults.
 */
export async function loadThemeSettings(database: D1Database | null | undefined): Promise<StoreThemeSettings> {
  if (!database || typeof database !== "object") return DEFAULT_THEME_SETTINGS;
  try {
    const row = await database.prepare("SELECT theme_settings FROM stores ORDER BY id LIMIT 1").first<{ theme_settings: string | null }>();
    return readThemeSettings(row?.theme_settings);
  } catch (error) {
    console.error("storefront-theme-settings-load", error instanceof Error ? error.message : "unknown");
    return DEFAULT_THEME_SETTINGS;
  }
}
