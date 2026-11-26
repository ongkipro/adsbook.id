// Guards for admin visual stability (Paduka, 2026-11-17: "kadang efek glitch,
// getar, dll review dan sempurnakan agar tidak terjadi"):
//
// 1. Every Inter face in admin.css is `font-display: optional` and preloaded by
//    the admin layouts — `@fontsource/inter/500.css` ships `swap`, which
//    reflowed buttons, tabs and menu rows when it landed.
// 2. No skeleton box swaps out for a hidden form (`class="h-60 …" id="*Loading"`
//    + `class="hidden …"` on the form): that pushed everything below it down up
//    to 2,855 px. Forms render from the first paint, dimmed and `inert`.
// 3. Shared buttons do not nudge 1 px on press (`translate-y-px`), which read
//    as a twitch on clicks, and do not animate layout properties (`transition-all`).
// 4. The admin layout holds its first paint until the shell's markup is parsed
//    (`<link rel="expect" blocking="render">` + a marker after `</AdminShell>`).
//    The page is streamed: painted half-parsed, the top bar, a settings row or
//    the order table is laid out without the siblings still on the wire and
//    moves when they arrive (measured 2026-11-26: /admin/payments 0.006,
//    /admin/ads 0.003, /admin/orders 0.002–0.009 on a slow runner).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".astro")) out.push(full);
  }
  return out.sort();
}

test("admin.css declares no swap font face, and both admin layouts preload Inter 500", () => {
  const css = readFileSync("src/styles/admin.css", "utf8");
  assert.doesNotMatch(css, /@import\s+["']@fontsource\/inter\//, "do not import @fontsource's swap sheet");
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(faces.length >= 2, "Inter 500 latin and latin-ext faces are declared");
  for (const face of faces) assert.match(face, /font-display:\s*optional\s*;/, face);
  for (const layout of ["src/layouts/AdminLayout.astro", "src/components/platform/PlatformLayout.astro"]) {
    const source = readFileSync(layout, "utf8");
    assert.match(source, /inter-latin-500-normal\.woff2\?url/, `${layout} imports Inter 500`);
    assert.match(source, /rel="preload" as="font"/, `${layout} preloads its faces`);
  }
});

test("admin Astro pages render their forms from the first paint, not behind a sized skeleton", () => {
  const offenders: string[] = [];
  for (const file of walk("src/pages/admin")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<(?:div|p)\s+[^>]*id="([a-zA-Z]*Loading)"[^>]*>/g)) {
      if (!/\bsr-only\b/.test(match[0])) offenders.push(`${file}: #${match[1]} has layout size (${match[0].slice(0, 90)})`);
    }
    for (const match of source.matchAll(/<form\s+[^>]*id="([a-zA-Z]+)"[^>]*>/g)) {
      const cls = match[0].match(/\bclass="([^"]*)"/)?.[1] ?? "";
      if (cls.split(/\s+/).includes("hidden")) offenders.push(`${file}: <form #${match[1]}> starts hidden`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("shared Button does not nudge on press or animate layout properties", () => {
  const button = readFileSync("src/components/ui/button.tsx", "utf8");
  assert.doesNotMatch(button, /translate-[xy]-/);
  assert.doesNotMatch(button, /\btransition-all\b/);
});

test("the admin layout holds its first paint until the shell is parsed", () => {
  const source = readFileSync("src/layouts/AdminLayout.astro", "utf8");
  const head = source.slice(source.indexOf("<head>"), source.indexOf("</head>"));
  const link = head.match(/<link\s+rel="expect"\s+href="#([\w-]+)"\s+blocking="render"\s*\/>/);
  assert.ok(link, "a render-blocking rel=expect link in <head>");
  const marker = source.indexOf(`id="${link[1]}"`);
  assert.ok(marker > source.indexOf("</AdminShell>"), "its target comes after the whole shell, so nothing paints half-parsed");
  assert.ok(marker < source.indexOf("</body>"), "and inside the body, or the paint would wait for the end of the document anyway");
});

test("admin popups and containers avoid lingering click-away borders and decorative zoom/slide effects", () => {
  const shell = readFileSync("src/components/admin/AdminShell.tsx", "utf8");
  assert.match(shell, /id="admin-main"[^>]*outline-none/, "#admin-main never flashes a page-wide focus border");

  for (const popupFile of [
    "src/components/ui/dropdown-menu.tsx",
    "src/components/ui/select.tsx",
    "src/components/ui/dialog.tsx",
  ]) {
    const src = readFileSync(popupFile, "utf8");
    // One shared rule (final-focus.ts): a close made in code must not drop a keyboard user on <body>.
    assert.match(src, /finalFocus = returnFocusUnlessPointer/, `${popupFile} uses the shared final-focus rule`);
    assert.doesNotMatch(src, /zoom-in-95|zoom-out-95|slide-in-from-/, `${popupFile} uses instant open without decorative zoom/slide`);
  }

  for (const controlFile of [
    "src/components/ui/switch.tsx",
    "src/components/ui/tabs.tsx",
    "src/components/ui/badge.tsx",
  ]) {
    assert.doesNotMatch(readFileSync(controlFile, "utf8"), /\btransition-all\b/, `${controlFile} avoids transition-all`);
  }
});

test("keyboard focus: every primitive draws a 2px accent ring, plain links and buttons an accent outline, text fields no second frame", () => {
  const css = readFileSync("src/styles/admin.css", "utf8");
  // The ring token is the accent (5.2:1 on white), not a tint or a grey (slate-300 is 1.5:1).
  assert.match(css, /\.admin-shell \{[^}]*--ring: var\(--admin-accent\);/, "admin --ring is the accent");
  assert.match(css, /\.admin-shell \{[^}]*--sidebar-ring: var\(--admin-accent\);/, "admin --sidebar-ring is the accent");
  for (const primitive of ["button", "input", "textarea", "checkbox", "switch", "select", "tabs", "badge"]) {
    const src = readFileSync(`src/components/ui/${primitive}.tsx`, "utf8");
    assert.match(src, /focus-visible:ring-2 focus-visible:ring-ring/, `${primitive} draws a 2px ring in the ring token`);
    assert.doesNotMatch(src, /ring-slate-300/, `${primitive} no longer draws a 1.5:1 grey ring`);
  }
  // The fallback outline: unlayered (inside a layer, a utility's outline-none wins), and never on a primitive or a text field.
  const rule = ".admin-shell :where(a, button):not([data-slot]):focus-visible";
  const at = css.indexOf(rule);
  assert.ok(at > 0, "the fallback rule covers plain links and buttons only");
  const open: boolean[] = [];
  for (let i = 0; i < at; i += 1) {
    if (css[i] === "{") open.push(/@layer\b/.test(css.slice(Math.max(css.lastIndexOf("}", i - 1), css.lastIndexOf(";", i - 1)) + 1, i)));
    else if (css[i] === "}") open.pop();
  }
  assert.equal(open.some(Boolean), false, "the fallback rule is not inside an @layer");
  assert.match(css.slice(at, css.indexOf("}", at)), /outline:\s*2px solid var\(--admin-accent\)/);
  assert.doesNotMatch(css, /:where\([^)]*\binput\b[^)]*\):focus-visible\s*\{\s*outline:\s*2px/, "a mouse click into a field must not add an outline over its own focus frame");
});
