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

/** Every provider value a single-tenant install read from Worker env. */
const FORMER_PROVIDER_ENV = new RegExp(
  `\\b(?:${[
    "MENGANTAR_API_KEY", "MENGANTAR_BASE_URL", "MENGANTAR_ORIGIN_AREA_ID", "MENGANTAR_PICKUP_ADDRESS_ID",
    "AUTOLARIS_API_KEY", "AUTOLARIS_BASE_URL", "AUTOLARIS_ORDER_ORIGIN_ID", "AUTOLARIS_ORDER_DESTINATION_ID",
    "AUTOLARIS_SHIPPER_EMAIL", "KELOLA_ORDER_WEBHOOK_URL", "KELOLA_ORDER_WEBHOOK_SECRET",
    "META_PIXEL_ID", "META_CAPI_ACCESS_TOKEN", "META_CAPI_TOKEN", "NEXT_PUBLIC_FB_PIXEL_ID", "PUBLIC_FB_PIXEL_ID",
    "FB_PIXEL_ID", "NEXT_PUBLIC_GTM_ID", "PUBLIC_GTM_ID", "GTM_ID", "GOOGLE_ADS_CONVERSION_ID",
    "GOOGLE_ADS_CONVERSION_LABEL", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_OFFLINE_START_AT",
  ].join("|")})\\b`,
);

test("T-45: no code outside src/platform reads a tenant value from the environment", () => {
  // getEnvValue fell back to import.meta.env and process.env, and every
  // provider credential once resolved through it: one Worker value for every
  // tenant. A tenant value is a row in that tenant's store.
  assert.deepEqual(offenders(/\bgetEnvValue\b|\bimport\.meta\.env\b/), [], "read the tenant's store instead");
  assert.deepEqual(
    offenders(FORMER_PROVIDER_ENV).filter((line) => !/^\S+:\d+: (?:\/\/|\*|\/\*)/.test(line)),
    [],
    "a provider env name outside a comment",
  );
});

test("T-20: no code outside src/platform names the shared ASSET_BUCKET or SESSION binding", () => {
  // TEN-3: an unprefixed key is a key another tenant can read or overwrite.
  // keys.ts is the one place that adds the tenant (and lives in src/platform/).
  assert.deepEqual(offenders(/\b(?:ASSET_BUCKET|SESSION)\b/), [], "use tenantR2 / tenantKv from src/platform/keys.ts");
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
