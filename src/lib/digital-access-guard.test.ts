// DIGITAL-PRODUCTS-SPEC §6.1/§8.4: a digital product's access link and note are
// read by the admin and by a paid, non-void order's status — nothing else. A
// public query that selected them would hand the product away for free, so the
// columns may be named only in the files below; a new reader fails here first.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;
// The migration is found by its suffix, never its number (schema-version.test.ts).
const MIGRATION_SUFFIX = "_digital_products_and_catalog_mode.sql";
const ALLOWED = new Set([
  "src/lib/product-mutation.ts",
  "src/pages/api/admin/products.ts",
  "src/components/admin/ProductForm.tsx",
  "src/platform/readiness.ts",
  "src/lib/digital-access.ts",
]);

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return files(path);
    return /\.(ts|tsx|astro|sql|mjs|js)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("only the admin, readiness and the paid order's access read the access link or note", () => {
  const naming = files("src").filter((path) => /digital_access_(?:url|note)/.test(readFileSync(join(ROOT, path), "utf8")));
  const outside = naming.filter((path) => !ALLOWED.has(path) && !(path.startsWith("src/db/migrations/") && path.endsWith(MIGRATION_SUFFIX)));
  assert.deepEqual(outside.sort(), [], "a new file names digital_access_url/note");
  for (const path of ALLOWED) assert.ok(naming.includes(path) || !path.endsWith(".ts"), `${relative(".", path)} still names them`);
});

test("the public catalogue selects the product type and never the access columns", () => {
  const catalog = readFileSync(join(ROOT, "src/lib/catalog.ts"), "utf8");
  assert.match(catalog, /product_type/);
  assert.doesNotMatch(catalog, /digital_access|SELECT \*/);
});
