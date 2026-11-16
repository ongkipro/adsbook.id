// T-52: the platform console is one visual system with the seller admin. It
// is built from the same primitives (`src/components/ui/*`) and the same admin
// patterns (`components/admin/useConfirm`, `filter-bar`, `AdminPageHeader`),
// and follows the same control contract (DESIGN-SYSTEM §7.1). These guards
// read the console's own files only; the seller admin's guards stay as they are.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

const CONSOLE = [
  ...globSync("src/components/platform/**/*.{tsx,astro}"),
  "src/pages/platform/[...section].astro",
  "src/pages/platform/login.astro",
];
const source = (file: string) => readFileSync(file, "utf8");

test("the console imports its controls from the shared ui kit, never a headless library directly", () => {
  const offenders = CONSOLE.filter((file) => /from\s+["'](?:radix-ui|@radix-ui\/[^"']+|@base-ui\/react[^"']*)["']/.test(source(file)));
  assert.deepEqual(offenders, []);
});

test("console destructive actions confirm through useConfirm, never window.confirm", () => {
  const offenders = CONSOLE.filter((file) => /\bwindow\.confirm\s*\(|(?<![\w.])confirm\s*\(\s*[`"']/.test(source(file)));
  assert.deepEqual(offenders, []);
});

test("console buttons and fields take their geometry from the primitive (DESIGN-SYSTEM §7.1)", () => {
  const banned = /^(?:sm:|md:|lg:)?(?:h-\d+(?:\.\d+)?|min-h-\d+|rounded(?:-(?!l-none|r-none|full)\S+)?|text-(?:xs|sm|base|\[[^\]]+\])|shadow(?:-\S+)?)$/;
  const offenders = CONSOLE.flatMap((file) =>
    [...source(file).matchAll(/<(Button|Input|Textarea|SelectTrigger)\b[^>]*?className="([^"]*)"/g)]
      .flatMap((match) => match[2].split(/\s+/).filter((token) => banned.test(token)).map((token) => `${file} <${match[1]}> ${token}`)),
  );
  assert.deepEqual(offenders, []);
});

test("console type stays on the admin scale: 12px floor, weights 400/500/600", () => {
  const banned = /(?<![\w-])(?:[a-z0-9]+:)*(?:text-\[(?:[0-9]|1[01])px\]|font-(?:bold|extrabold|black)|text-[3-9]xl)(?![\w-])/g;
  const offenders = CONSOLE.filter((file) => file !== "src/pages/platform/login.astro").flatMap((file) =>
    [...source(file).matchAll(banned)].map((match) => `${file} ${match[0]}`),
  );
  assert.deepEqual(offenders, []);
});

test("the console reuses the seller admin's shell pieces rather than copies of them", () => {
  const shell = source("src/components/platform/PlatformShell.tsx");
  for (const piece of ["@/components/ui/sidebar", "@/components/ui/command", "@/components/ui/sheet", "@/components/ui/dropdown-menu", "@/components/ui/sonner", "../admin/admin-navigation", "../admin/topbar-styles"]) {
    assert.ok(shell.includes(piece), `PlatformShell imports ${piece}`);
  }
  const layout = source("src/components/platform/PlatformLayout.astro");
  assert.match(layout, /import '\.\.\/\.\.\/styles\/admin\.css'/, "one stylesheet with the seller admin");
  assert.match(layout, /class="admin-shell /, "the same .admin-shell body scope");
  for (const file of globSync("src/components/platform/sections/*.astro")) {
    assert.match(source(file), /AdminPageHeader/, `${file} uses the seller admin's page header`);
  }
  const filters = source("src/components/platform/ConsoleFilters.tsx");
  assert.match(filters, /from "\.\.\/admin\/filter-bar"/, "filters are the seller admin's FilterBar");
});

test("the console page width is the shell's 1560px box, like the seller admin", () => {
  assert.match(source("src/components/platform/PlatformShell.tsx"), /max-w-\[1560px\]/);
  const offenders = globSync("src/components/platform/sections/*.astro").filter((file) => /\bmx-auto\b[^"]*\bmax-w-(?:5xl|6xl|7xl)\b|\bmax-w-(?:5xl|6xl|7xl)\b[^"]*\bmx-auto\b/.test(source(file)));
  assert.deepEqual(offenders, []);
});

test("no Base UI Select inside a console dialog: it cannot open under a Radix modal (use FilterSelect)", () => {
  // Found in the Tim "Tambah anggota" dialog (2026-11-17): the Radix Dialog
  // sets pointer-events:none outside its content and Base UI portals the
  // Select popup to <body>, so the role field never opened.
  const offenders = globSync("src/components/platform/**/*.tsx").filter((file) => {
    const text = source(file);
    return /<DialogContent\b/.test(text) && /from\s+["'][./@a-z/-]*ui\/select["']/.test(text);
  });
  assert.deepEqual(offenders, []);
});
