// TEN-2 (T-46): tenant data is reachable only through the tenant capability.
// A store binding named outside src/platform/ is a route around the gate.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return files(path);
    return /\.(ts|tsx|astro|mjs|js)$/.test(name) ? [path] : [];
  });
}

/** Code that ships or runs against a store: everything except tests, type declarations and the platform itself. */
const SCANNED = [...files("src"), ...files("scripts")].filter(
  (path) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts") && !path.startsWith("src/platform/"),
);

function offenders(pattern: RegExp): string[] {
  return SCANNED.flatMap((path) =>
    readFileSync(join(ROOT, path), "utf8")
      .split("\n")
      .flatMap((line, index) => (pattern.test(line) ? [`${relative(ROOT, join(ROOT, path))}:${index + 1}: ${line.trim()}`] : [])),
  );
}

test("no code outside src/platform names the shared OMS_DB binding", () => {
  assert.deepEqual(offenders(/\bOMS_DB\b/), [], "read the tenant store through tenantDatabase(locals) or a parameter");
});

test("no code outside src/platform reaches the TenantStore namespace", () => {
  assert.deepEqual(offenders(/\bTENANT_STORE\b/), [], "only src/platform/tenant-db.ts opens a tenant store");
});

test("the scan itself covers the code it guards", () => {
  assert.ok(SCANNED.includes("src/middleware.ts"));
  assert.ok(SCANNED.some((path) => path.startsWith("src/pages/api/v1/")));
  assert.ok(SCANNED.some((path) => path.startsWith("src/plugins/")));
  assert.ok(SCANNED.some((path) => path.startsWith("scripts/")));
  assert.equal(SCANNED.some((path) => path.startsWith("src/platform/")), false);
});

test("wrangler.jsonc binds no store D1: tenant data is one TenantStore per tenant", () => {
  const config = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  assert.doesNotMatch(config, /"binding":\s*"OMS_DB"/);
  assert.match(config, /"name":\s*"TENANT_STORE",\s*"class_name":\s*"TenantStore"/);
});
