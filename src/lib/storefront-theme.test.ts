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

test("theme settings: a missing or broken row reads as the defaults, a valid one as itself", (t) => {
  t.mock.method(console, "error", () => undefined);
  assert.deepEqual(readThemeSettings(null), DEFAULT_THEME_SETTINGS);
  assert.deepEqual(readThemeSettings("{not json"), DEFAULT_THEME_SETTINGS);
  assert.deepEqual(readThemeSettings(JSON.stringify({ sections: { banner: false } })), DEFAULT_THEME_SETTINGS, "an incomplete row is not half-applied");
  const custom = { sections: { banner: false, trustStrip: true }, catalog: { title: "Madu pilihan", description: "" } };
  assert.deepEqual(readThemeSettings(JSON.stringify(custom)), custom);
});

test("theme settings: a write is validated, with an Indonesian reason, and refuses markup and unknown keys", () => {
  const good = { sections: { banner: true, trustStrip: false }, catalog: { title: "Produk kami", description: "Dikirim dari Bandung." } };
  assert.deepEqual(parseThemeSettingsInput(good), { ok: true, settings: good });
  assert.deepEqual(parseThemeSettingsInput({ ...good, catalog: { title: "x", description: "" } }), { ok: false, error: "Judul katalog 2–60 karakter." });
  assert.deepEqual(parseThemeSettingsInput({ ...good, catalog: { title: "<b>Promo</b>", description: "" } }), { ok: false, error: "Judul dan deskripsi tidak boleh berisi tanda < atau >." });
  assert.equal(parseThemeSettingsInput({ ...good, extra: 1 }).ok, false);
  assert.equal(parseThemeSettingsInput({ ...good, sections: { banner: "yes", trustStrip: true } }).ok, false);
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
