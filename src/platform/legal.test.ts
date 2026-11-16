// T-39 (PR-24): versioned legal texts, the renderer, and the store notice (PRIV-2).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CURRENT_LEGAL_VERSION, legalText, renderLegalMarkdown, storePrivacyMarkdown, type StoreProviders } from "./legal.ts";
import { LEGAL_TEXTS } from "./legal-texts.ts";

// Each published version, byte for byte (SHA-256 of the v0.1 drafts in
// adsbook.id-docs/docs/product/legal-drafts/). Sellers accepted exactly this
// text: a change is a new version key, never an edit of one listed here.
const PUBLISHED: Record<string, string> = {
  "seller-terms@0.1": "bb93dc2ebcfa1dc533024c578a9e1092244f9886862d3c5059fb8a682080df42",
  "platform-privacy@0.1": "f4849347f4b174a7374af09732997cde447d3bf91bb674ba6565b5cd36979e4b",
  "store-privacy@0.1": "db557f2aa4be2e0a22345460c04961c25ca8c2d84f1a07841711b259763e827e",
};

test("a published legal version never changes, and none disappears", () => {
  for (const [key, digest] of Object.entries(PUBLISHED)) {
    const [doc, version] = key.split("@") as [keyof typeof LEGAL_TEXTS, string];
    const entry = LEGAL_TEXTS[doc][version];
    assert.ok(entry, `${key} was removed`);
    assert.equal(createHash("sha256").update(entry.text).digest("hex"), digest, `${key} was edited in place`);
  }
  for (const [doc, versions] of Object.entries(LEGAL_TEXTS)) {
    for (const version of Object.keys(versions)) assert.ok(PUBLISHED[`${doc}@${version}`], `${doc}@${version} is published but not pinned here`);
  }
  for (const [doc, version] of Object.entries(CURRENT_LEGAL_VERSION)) assert.ok(PUBLISHED[`${doc}@${version}`], `current ${doc} is pinned`);
});

test("a version is served exactly; an unknown one is not served at all", () => {
  assert.equal(legalText("seller-terms", "0.1")?.text, LEGAL_TEXTS["seller-terms"]["0.1"].text);
  assert.equal(legalText("seller-terms")?.version, CURRENT_LEGAL_VERSION["seller-terms"]);
  assert.equal(legalText("seller-terms", "9.9"), null);
  assert.equal(legalText("seller-terms", ""), null, "an empty ?v= is not the current version");
  assert.equal(legalText("seller-terms", "__proto__"), null);
});

test("the renderer escapes everything, renders the drafts' subset, and marks unfilled placeholders", () => {
  const html = renderLegalMarkdown(
    "## Judul <b>\n\nParagraf **tebal** dan `kode`\nlanjut {nama} {belum}.\n\n1. satu\n   lanjutan\n2. dua\n\n- a\n- <img src=x onerror=alert(1)>\n\n> catatan",
    { nama: "Toko <A>" },
  );
  assert.match(html, /<h2>Judul &lt;b&gt;<\/h2>/, "## is a section heading under the page's h1");
  assert.match(html, /<p>Paragraf <strong>tebal<\/strong> dan <code>kode<\/code> lanjut Toko &lt;A&gt; <mark>\{belum\}<\/mark>\.<\/p>/);
  assert.match(html, /<ol><li>satu lanjutan<\/li><li>dua<\/li><\/ol>/);
  assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt;<\/li>/);
  assert.match(html, /<blockquote>catatan<\/blockquote>/);
  assert.doesNotMatch(html, /<img|<b>/);
  const table = renderLegalMarkdown("| Data | Peran |\n| --- | --- |\n| Akun <x> | **pengendali** |\n| Pembeli | pemroses |");
  assert.match(table, /<table><thead><tr><th scope="col">Data<\/th><th scope="col">Peran<\/th><\/tr><\/thead><tbody>/);
  assert.match(table, /<td data-label="Data">Akun &lt;x&gt;<\/td><td data-label="Peran"><strong>pengendali<\/strong><\/td>/);
  assert.equal((table.match(/<tr>/g) ?? []).length, 3, "the separator row is not a row");
  assert.doesNotMatch(table, /\| ---/);
});

const NONE: StoreProviders = { meta: false, google: false, mengantar: false, autolaris: false, kelola: false };
const template = LEGAL_TEXTS["store-privacy"]["0.1"].text;

test("PRIV-2 / PR-24: a store with only Meta enabled names Meta and not Google Ads", () => {
  const notice = storePrivacyMarkdown(template, { ...NONE, meta: true }, "");
  assert.match(notice, /iklan Kami di Meta/);
  assert.doesNotMatch(notice, /Google/);
  assert.doesNotMatch(notice, /\[jika|Mengantar|AutoLaris|Kelola/);
  assert.match(notice, /adsbook\.id dan Cloudflare/, "hosting is always named");
  assert.match(notice, /^# Kebijakan Privasi \{nama_toko\}/, "the template's own instructions are not shown");
});

test("PRIV-2: each provider line appears exactly when that provider is on", () => {
  const lines: Record<keyof StoreProviders, RegExp> = {
    meta: /di Meta/, google: /di Google/, mengantar: /Mengantar dan kurirnya/, autolaris: /AutoLaris — data pembayaran/, kelola: /Kelola — nama/,
  };
  for (const key of Object.keys(lines) as Array<keyof StoreProviders>) {
    const notice = storePrivacyMarkdown(template, { ...NONE, [key]: true }, "");
    for (const [other, pattern] of Object.entries(lines)) {
      assert.equal(pattern.test(notice), other === key, `${key} on: ${other}`);
    }
  }
  // A marker the code does not know drops its line instead of showing it.
  assert.doesNotMatch(storePrivacyMarkdown("# Kebijakan Privasi X\n- [jika Baru aktif] baris", { ...NONE, meta: true }, ""), /baris/);
});

test("the seller's own section is appended as its own part and stays text", () => {
  const notice = storePrivacyMarkdown(template, NONE, "Kami juga <script>alert(1)</script> melayani via telepon.");
  assert.match(notice, /## Informasi tambahan dari toko\n\nKami juga/);
  assert.doesNotMatch(renderLegalMarkdown(notice), /<script>/);
  assert.equal(storePrivacyMarkdown(template, NONE, "   ").includes("Informasi tambahan"), false);
});
