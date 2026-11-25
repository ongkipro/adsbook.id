import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// DESIGN-SYSTEM §2.3 & §3: the public seller storefront uses --sf-* tokens,
// keeps a 12px type floor, never drifts back to Tailwind's slate palette, and
// never ships copy from an inherited merchant.
const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".astro")) out.push(full);
  }
  return out;
}

const PUBLIC_FILES = [
  ...walk(join(ROOT, "components/storefront")).filter(
    // Landing-page kit components are used by merchant-authored landing pages.
    (file) => !file.includes("/landing-pages/"),
  ),
  join(ROOT, "layouts/BaseLayout.astro"),
  join(ROOT, "pages/index.astro"),
  join(ROOT, "pages/404.astro"),
  join(ROOT, "pages/produk/index.astro"),
  join(ROOT, "pages/produk/[slug].astro"),
  join(ROOT, "pages/payment.astro"),
  join(ROOT, "pages/thanks.astro"),
  join(ROOT, "pages/landing-page/index.astro"),
  join(ROOT, "pages/kontak.astro"),
  join(ROOT, "pages/pengiriman.astro"),
  join(ROOT, "pages/tentang.astro"),
  join(ROOT, "pages/testimoni.astro"),
  join(ROOT, "pages/sitemap.astro"),
  join(ROOT, "pages/kebijakan-privasi.astro"),
  join(ROOT, "pages/kebijakan-cookie.astro"),
  join(ROOT, "pages/syarat-ketentuan.astro"),
  join(ROOT, "pages/disclaimer.astro"),
];

function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

test("public storefront keeps the 12px type floor (no text-[9..11px])", () => {
  const hits: string[] = [];
  for (const file of PUBLIC_FILES) {
    const clean = stripComments(readFileSync(file, "utf8"));
    const matches = clean.match(/text-\[(?:9|10|11)px\]/g);
    if (matches) hits.push(`${file.slice(ROOT.length)}: ${matches.join(", ")}`);
  }
  assert.deepEqual(hits, []);
});

test("public storefront uses --sf-* tokens instead of Tailwind slate utilities", () => {
  const hits: string[] = [];
  for (const file of PUBLIC_FILES) {
    const clean = stripComments(readFileSync(file, "utf8"));
    const matches = clean.match(/\b(?:bg|text|border|ring|outline)-slate-[0-9]{2,3}\b/g);
    if (matches) hits.push(`${file.slice(ROOT.length)}: ${matches.join(", ")}`);
  }
  assert.deepEqual(hits, []);
});

test("public storefront markup carries no inherited merchant copy", () => {
  const hits: string[] = [];
  for (const file of PUBLIC_FILES) {
    const clean = stripComments(readFileSync(file, "utf8"));
    const match = clean.match(/solusi pertanian|petanisejahtera|permatamall/i);
    if (match) hits.push(`${file.slice(ROOT.length)}: ${match[0]}`);
  }
  assert.deepEqual(hits, []);
});
