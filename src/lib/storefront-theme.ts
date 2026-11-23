import { z } from "zod";

/**
 * Admin › Tema › Atur beranda: the homepage a store composes on top of its
 * theme (`stores.storefront_template`). Stored as JSON in
 * `stores.theme_settings` (migration 0086); NULL, a v1 row (switches and the
 * catalogue heading, 2026-11-23 morning) or anything that fails this schema
 * reads as the defaults or is lifted to v2, so a bad row never takes the
 * storefront down. The banner image lives in `storefront_content` 'home'
 * (R1b) and the accent in `stores.theme_color`.
 *
 * v2 (owner, 2026-11-23: the section builder, without buyer reviews): an
 * ordered list of sections, each on or off, inside the 480px column. Every
 * section shows only what is true of this store: the trust strip and "Cara
 * pesan" are derived from its checkout settings, the hero and "Pilihan kami"
 * from its own active products, and the announcement from what the seller
 * typed, until the date they chose.
 */
export const HOME_SECTION_IDS = ["announcement", "hero", "trust", "featured", "catalog", "howToOrder"] as const;
export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];

export const CATALOG_SORTS = ["newest", "bestselling", "price_asc", "price_desc"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

const safeText = (max: number, min = 0) =>
  z.string().trim().min(min).max(max).refine((value) => !/[<>]/.test(value), { message: "markup" });
const productId = z.string().trim().regex(/^\d{1,12}$/);

export const storeThemeSettingsSchema = z
  .object({
    version: z.literal(2),
    order: z.array(z.enum(HOME_SECTION_IDS)).length(HOME_SECTION_IDS.length).refine((ids) => new Set(ids).size === ids.length, { message: "duplicate" }),
    sections: z
      .object({
        announcement: z
          .object({
            enabled: z.boolean(),
            text: safeText(90),
            href: z.union([z.literal(""), z.string().trim().max(200).regex(/^(\/(?!\/)[^\s<>"]*|https:\/\/[^\s<>"]+)$/)]),
            // YYYY-MM-DD, inclusive, in WIB; "" = no end.
            until: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
          })
          .strict(),
        hero: z
          .object({
            enabled: z.boolean(),
            source: z.enum(["auto", "products", "banner"]),
            productIds: z.array(productId).max(5),
            summary: z.boolean(),
          })
          .strict(),
        trust: z.object({ enabled: z.boolean() }).strict(),
        featured: z
          .object({
            enabled: z.boolean(),
            title: safeText(40, 2),
            productIds: z.array(productId).max(6),
          })
          .strict(),
        catalog: z
          .object({
            enabled: z.literal(true),
            title: safeText(60, 2),
            description: safeText(160),
            sort: z.enum(CATALOG_SORTS),
            categories: z.boolean(),
          })
          .strict(),
        howToOrder: z.object({ enabled: z.boolean() }).strict(),
      })
      .strict(),
  })
  .strict();

export type StoreThemeSettings = z.infer<typeof storeThemeSettingsSchema>;

export const DEFAULT_THEME_SETTINGS: StoreThemeSettings = {
  version: 2,
  order: ["announcement", "hero", "trust", "featured", "catalog", "howToOrder"],
  sections: {
    announcement: { enabled: false, text: "", href: "", until: "" },
    hero: { enabled: true, source: "auto", productIds: [], summary: true },
    trust: { enabled: true },
    featured: { enabled: false, title: "Pilihan kami", productIds: [] },
    catalog: {
      enabled: true,
      title: "Produk pilihan",
      description: "Pilih produk, cek varian dan harga, lalu pesan langsung dari halamannya.",
      sort: "newest",
      categories: true,
    },
    howToOrder: { enabled: false },
  },
};

const v1Schema = z
  .object({
    sections: z.object({ banner: z.boolean(), trustStrip: z.boolean() }).strict(),
    catalog: z.object({ title: z.string().trim().min(2).max(60), description: z.string().trim().max(160) }).strict(),
  })
  .strict();

const fresh = (): StoreThemeSettings => structuredClone(DEFAULT_THEME_SETTINGS);

/** The stored JSON as v2: a v1 row is lifted, an absent or invalid one reads as the defaults (logged, never thrown). */
export function readThemeSettings(stored: string | null | undefined): StoreThemeSettings {
  if (!stored) return fresh();
  try {
    const raw = JSON.parse(stored);
    const v2 = storeThemeSettingsSchema.safeParse(raw);
    if (v2.success) return v2.data;
    const v1 = v1Schema.safeParse(raw);
    if (v1.success) {
      const lifted = fresh();
      lifted.sections.hero.enabled = v1.data.sections.banner;
      lifted.sections.trust.enabled = v1.data.sections.trustStrip;
      lifted.sections.catalog.title = v1.data.catalog.title;
      lifted.sections.catalog.description = v1.data.catalog.description;
      return lifted;
    }
    throw new Error(v2.error.issues[0]?.path.join(".") || "invalid");
  } catch (error) {
    console.error("storefront-theme-settings-invalid", error instanceof Error ? error.message : "unknown");
    return fresh();
  }
}

const FIELD_ERRORS: Array<[RegExp, string]> = [
  [/^sections\.announcement\.text/, "Teks pengumuman maksimal 90 karakter, tanpa tanda < atau >."],
  [/^sections\.announcement\.href/, "Link pengumuman harus diawali / (halaman toko) atau https://."],
  [/^sections\.announcement\.until/, "Tanggal berakhir pengumuman tidak valid."],
  [/^sections\.hero\.productIds/, "Hero memuat paling banyak 5 produk."],
  [/^sections\.featured\.title/, "Judul Pilihan kami 2–40 karakter, tanpa tanda < atau >."],
  [/^sections\.featured\.productIds/, "Pilihan kami memuat paling banyak 6 produk."],
  [/^sections\.catalog\.title/, "Judul katalog 2–60 karakter, tanpa tanda < atau >."],
  [/^sections\.catalog\.description/, "Deskripsi katalog maksimal 160 karakter, tanpa tanda < atau >."],
  [/^order/, "Urutan bagian beranda tidak valid."],
];

/** Validates a settings write with an Indonesian reason; cross-field rules after the schema. */
export function parseThemeSettingsInput(value: unknown): { ok: true; settings: StoreThemeSettings } | { ok: false; error: string } {
  const parsed = storeThemeSettingsSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "";
    return { ok: false, error: FIELD_ERRORS.find(([pattern]) => pattern.test(field))?.[1] ?? "Pengaturan beranda tidak valid." };
  }
  const { announcement, hero, featured } = parsed.data.sections;
  if (announcement.enabled && announcement.text.length < 3) return { ok: false, error: "Isi teks pengumuman, atau matikan pengumuman." };
  if (hero.enabled && hero.source === "products" && hero.productIds.length === 0) return { ok: false, error: "Pilih minimal 1 produk untuk hero, atau pakai pilihan otomatis." };
  if (featured.enabled && featured.productIds.length < 2) return { ok: false, error: "Pilihan kami butuh minimal 2 produk." };
  return { ok: true, settings: parsed.data };
}

/** Today in WIB as YYYY-MM-DD, the day an announcement's `until` is compared with. */
export function wibDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** The announcement to show now, or null: on, written, and not past its last day (inclusive, WIB). */
export function liveAnnouncement(settings: StoreThemeSettings, now: Date): { text: string; href: string } | null {
  const { enabled, text, href, until } = settings.sections.announcement;
  if (!enabled || !text) return null;
  if (until && wibDate(now) > until) return null;
  return { text, href };
}

/**
 * Products in the seller's order, only those still active in this store's
 * catalogue: a deleted or drafted product drops out instead of breaking a
 * section, and nothing from another store can be named here.
 */
export function pickProductsById<T extends { catalogId?: number | string; productId?: string }>(catalog: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(catalog.map((product) => [String(product.catalogId ?? ""), product]));
  return ids.map((id) => byId.get(id)).filter((product): product is T => Boolean(product));
}

/** The catalogue in the seller's chosen order; ties keep the catalogue's own (newest first). */
export function sortCatalog<T extends { price: number; soldCount?: number }>(products: readonly T[], sort: CatalogSort): T[] {
  const indexed = products.map((product, index) => ({ product, index }));
  const by = {
    newest: () => 0,
    bestselling: (a: T, b: T) => (b.soldCount ?? 0) - (a.soldCount ?? 0),
    price_asc: (a: T, b: T) => a.price - b.price,
    price_desc: (a: T, b: T) => b.price - a.price,
  }[sort];
  return indexed.sort((a, b) => by(a.product, b.product) || a.index - b.index).map(({ product }) => product);
}

/** "Cara pesan": three steps, written from what this store actually offers. */
export function howToOrderSteps(facts: { payments: readonly string[] }): Array<{ title: string; text: string }> {
  const cod = facts.payments.some((payment) => payment.startsWith("COD"));
  const online = facts.payments.some((payment) => payment === "QRIS" || payment.startsWith("Virtual Account") || payment.startsWith("transfer bank"));
  const pay = cod && online ? "Bayar di tempat (COD) atau bayar online." : cod ? "Bayar di tempat saat paket tiba (COD)." : online ? "Bayar online lewat QRIS atau transfer." : "Ikuti instruksi pembayaran setelah pesan.";
  return [
    { title: "Pilih produk", text: "Buka produk, pilih varian yang Anda mau." },
    { title: "Isi data", text: cod ? "Nama, nomor WhatsApp, dan alamat pengiriman." : "Nama dan nomor WhatsApp aktif." },
    { title: "Bayar", text: pay },
  ];
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
