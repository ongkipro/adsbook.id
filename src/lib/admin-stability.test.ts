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
