import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// ADR-019: a store re-brands by overriding the --sf-accent tokens, never a call
// site. The payment page is where the buyer pays, so it follows the same tokens.
const source = readFileSync(new URL("../pages/payment.astro", import.meta.url), "utf8");

test("the payment page loads the token layer and carries its root", () => {
  assert.match(source, /import '\.\.\/styles\/form-hybrid\.css'/);
  assert.match(source, /<main data-hybrid-form-root/);
});

test("primary controls take the accent token, not a hard-coded ink", () => {
  assert.doesNotMatch(source, /(?:bg|border)-\[#(?:121212|000000)\]/);
  assert.match(source, /bg-\[var\(--sf-accent\)\]/);
  assert.match(source, /hover:bg-\[var\(--sf-accent-strong\)\]/);
});

test("the default public & form accent is brand blue (#2563eb), with no orange or gold fallbacks", () => {
  const formCss = readFileSync(new URL("../styles/form-hybrid.css", import.meta.url), "utf8");
  assert.match(formCss, /--sf-accent:\s*#2563eb;/i);
  assert.match(formCss, /--sf-accent-strong:\s*#1d4ed8;/i);
  assert.match(formCss, /--sf-accent-soft:\s*#eff6ff;/i);
  assert.doesNotMatch(formCss, /#c2410c|#9a3412|#fff7ed/i);

  for (const rel of [
    "../pages/thanks.astro",
    "../pages/produk/[slug].astro",
    "../pages/404.astro",
    "../pages/testimoni.astro",
    "../pages/landing-page/index.astro",
    "../pages/api/handoff.ts",
    "../styles/landing-pages/landing.css",
    "../styles/landing-pages/kit.css",
  ]) {
    const file = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(file, /#c2410c|#9a3412|#c5a880/i, `${rel} keeps no orange or gold fallback`);
  }
});
