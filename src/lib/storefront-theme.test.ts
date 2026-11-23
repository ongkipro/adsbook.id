import assert from "node:assert/strict";
import test from "node:test";
import {
  accentTokens,
  checkAccent,
  contrastRatio,
  DEFAULT_THEME_SETTINGS,
  parseThemeSettingsInput,
  readThemeSettings,
} from "./storefront-theme.ts";

test("theme settings: a missing or broken row reads as the defaults; a v1 row is lifted to v2", (t) => {
  t.mock.method(console, "error", () => undefined);
  assert.deepEqual(readThemeSettings(null), DEFAULT_THEME_SETTINGS);
  assert.deepEqual(readThemeSettings("{not json"), DEFAULT_THEME_SETTINGS);
  assert.deepEqual(readThemeSettings(JSON.stringify({ sections: { banner: false } })), DEFAULT_THEME_SETTINGS, "an incomplete row is not half-applied");
  // A store saved before the builder keeps what it chose.
  const v1 = { sections: { banner: false, trustStrip: true }, catalog: { title: "Madu pilihan", description: "" } };
  const lifted = readThemeSettings(JSON.stringify(v1));
  assert.equal(lifted.version, 2);
  assert.equal(lifted.sections.hero.enabled, false);
  assert.equal(lifted.sections.trust.enabled, true);
  assert.equal(lifted.sections.catalog.title, "Madu pilihan");
  assert.deepEqual(lifted.order, DEFAULT_THEME_SETTINGS.order);
  // A v2 row reads as itself, and the defaults are never mutated through a read.
  const custom = structuredClone(DEFAULT_THEME_SETTINGS);
  custom.order = ["hero", "catalog", "featured", "trust", "announcement", "howToOrder"];
  custom.sections.catalog.sort = "price_asc";
  assert.deepEqual(readThemeSettings(JSON.stringify(custom)), custom);
  readThemeSettings(null).sections.catalog.title = "changed";
  assert.equal(DEFAULT_THEME_SETTINGS.sections.catalog.title, "Produk pilihan");
});

test("theme settings: a write is validated with an Indonesian reason; markup, unknown keys and broken orders are refused", () => {
  const good = structuredClone(DEFAULT_THEME_SETTINGS);
  assert.deepEqual(parseThemeSettingsInput(good), { ok: true, settings: good });
  const withTitle = (title: string) => ({ ...good, sections: { ...good.sections, catalog: { ...good.sections.catalog, title } } });
  assert.deepEqual(parseThemeSettingsInput(withTitle("x")), { ok: false, error: "Judul katalog 2–60 karakter, tanpa tanda < atau >." });
  assert.deepEqual(parseThemeSettingsInput(withTitle("<b>Promo</b>")), { ok: false, error: "Judul katalog 2–60 karakter, tanpa tanda < atau >." });
  assert.equal(parseThemeSettingsInput({ ...good, extra: 1 }).ok, false);
  assert.equal(parseThemeSettingsInput({ ...good, order: ["hero", "hero", "trust", "featured", "catalog", "howToOrder"] }).ok, false, "a duplicate section");
  assert.equal(parseThemeSettingsInput({ ...good, order: good.order.slice(1) }).ok, false, "a missing section");
  assert.equal(parseThemeSettingsInput({ ...good, sections: { ...good.sections, catalog: { ...good.sections.catalog, enabled: false } } }).ok, false, "the catalogue cannot be switched off");
  const announce = (patch: Record<string, unknown>) => ({ ...good, sections: { ...good.sections, announcement: { ...good.sections.announcement, ...patch } } });
  assert.deepEqual(parseThemeSettingsInput(announce({ enabled: true, text: "" })), { ok: false, error: "Isi teks pengumuman, atau matikan pengumuman." });
  assert.equal(parseThemeSettingsInput(announce({ enabled: true, text: "Gratis ongkir", href: "/produk" })).ok, true);
  assert.equal(parseThemeSettingsInput(announce({ enabled: true, text: "Promo", href: "https://wa.me/628123" })).ok, true);
  for (const href of ["http://x.test", "javascript:alert(1)", "//evil.test", "produk"]) {
    assert.deepEqual(parseThemeSettingsInput(announce({ enabled: true, text: "Promo", href })), { ok: false, error: "Link pengumuman harus diawali / (halaman toko) atau https://." }, href);
  }
  const hero = { ...good, sections: { ...good.sections, hero: { ...good.sections.hero, source: "products" as const, productIds: [] } } };
  assert.deepEqual(parseThemeSettingsInput(hero), { ok: false, error: "Pilih minimal 1 produk untuk hero, atau pakai pilihan otomatis." });
  const featured = { ...good, sections: { ...good.sections, featured: { ...good.sections.featured, enabled: true, productIds: ["1"] } } };
  assert.deepEqual(parseThemeSettingsInput(featured), { ok: false, error: "Pilihan kami butuh minimal 2 produk." });
  assert.equal(parseThemeSettingsInput({ ...featured, sections: { ...featured.sections, featured: { ...featured.sections.featured, productIds: ["1", "x"] } } }).ok, false, "ids are digits");
});

test("homepage helpers: announcement window in WIB, products by id, catalogue order, how-to-order from real payments", async () => {
  const { liveAnnouncement, pickProductsById, sortCatalog, howToOrderSteps, wibDate } = await import("./storefront-theme.ts");
  const settings = structuredClone(DEFAULT_THEME_SETTINGS);
  settings.sections.announcement = { enabled: true, text: "Gratis ongkir", href: "", until: "2026-11-30" };
  // 2026-11-30 23:30 WIB is still the 30th; 2026-11-30 17:30 UTC is 00:30 WIB on the 1st.
  assert.deepEqual(liveAnnouncement(settings, new Date("2026-11-30T16:30:00Z")), { text: "Gratis ongkir", href: "" });
  assert.equal(liveAnnouncement(settings, new Date("2026-11-30T17:30:00Z")), null);
  assert.equal(wibDate(new Date("2026-11-30T17:30:00Z")), "2026-12-01");
  settings.sections.announcement.until = "";
  assert.ok(liveAnnouncement(settings, new Date("2030-01-01T00:00:00Z")), "no end date");
  settings.sections.announcement.enabled = false;
  assert.equal(liveAnnouncement(settings, new Date()), null);

  const catalog = [
    { catalogId: 3, name: "C", price: 30000, soldCount: 5 },
    { catalogId: 1, name: "A", price: 10000, soldCount: 50 },
    { catalogId: 2, name: "B", price: 20000 },
  ];
  assert.deepEqual(pickProductsById(catalog, ["2", "9", "3"]).map((p) => p.name), ["B", "C"], "seller's order; a missing product drops out");
  assert.deepEqual(sortCatalog(catalog, "newest").map((p) => p.name), ["C", "A", "B"]);
  assert.deepEqual(sortCatalog(catalog, "bestselling").map((p) => p.name), ["A", "C", "B"]);
  assert.deepEqual(sortCatalog(catalog, "price_asc").map((p) => p.name), ["A", "B", "C"]);
  assert.deepEqual(sortCatalog(catalog, "price_desc").map((p) => p.name), ["C", "B", "A"]);

  assert.match(howToOrderSteps({ payments: ["COD (bayar di tempat)", "QRIS"] })[2].text, /COD.*online/);
  assert.match(howToOrderSteps({ payments: ["QRIS"] })[1].text, /^Nama dan nomor WhatsApp/, "no address asked for a prepaid-only store");
  assert.match(howToOrderSteps({ payments: ["COD (bayar di tempat)"] })[2].text, /COD/);
});

test("UI-2: an accent is accepted only when white button text on it reaches 4.5:1", () => {
  assert.ok(contrastRatio("#2563EB", "#ffffff") > 5);
  assert.deepEqual(checkAccent("#2563eb"), { ok: true, accent: "#2563EB" });
  assert.deepEqual(checkAccent(" #0f766e "), { ok: true, accent: "#0F766E" });
  const yellow = checkAccent("#FACC15");
  assert.equal(yellow.ok, false);
  assert.match((yellow as { error: string }).error, /terlalu terang.*minimal 4,5:1/);
  assert.equal(checkAccent("blue").ok, false);
  assert.equal(checkAccent("#fff").ok, false);
});

test("accent tokens: none for the default or an unreadable colour, the four --sf-* tokens otherwise", () => {
  assert.equal(accentTokens(""), "");
  assert.equal(accentTokens("#2563eb"), "", "the stylesheet's own values stand");
  assert.equal(accentTokens("#FACC15"), "", "a stored colour that fails UI-2 never renders");
  assert.equal(accentTokens("javascript:alert(1)"), "");
  const tokens = accentTokens("#0F766E");
  assert.match(tokens, /^--sf-accent:#0F766E;--sf-accent-strong:#[0-9a-f]{6};--sf-accent-soft:#[0-9a-f]{6};--sf-accent-ring:rgba\(15, 118, 110, 0\.28\);--sf-brand-accent:#0F766E;/);
  const strong = /--sf-accent-strong:(#[0-9a-f]{6})/.exec(tokens)![1];
  assert.ok(contrastRatio(strong, "#ffffff") > contrastRatio("#0F766E", "#ffffff"), "the hover shade is darker");
});
