import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authFor,
  buildModuleMap,
  buildRouteMap,
  classify,
  exportsOf,
  knownTables,
  libImportsOf,
  methodsOf,
  PAGES_DIR,
  tablesOf,
  toRoutePath,
  toXml,
} from "./route-map.ts";
import { CMS_VERSION } from "./version.ts";

test("a file path becomes the URL it actually serves", () => {
  assert.equal(toRoutePath("index.astro"), "/");
  assert.equal(toRoutePath("produk/index.astro"), "/produk");
  assert.equal(toRoutePath("produk/[slug].astro"), "/produk/[slug]");
  assert.equal(toRoutePath("assets/[...key].ts"), "/assets/[...key]");
  // Only the final extension is a file extension. `robots.txt.ts` serves
  // `/robots.txt`, and stripping both would have produced `/robots`.
  assert.equal(toRoutePath("robots.txt.ts"), "/robots.txt");
  assert.equal(toRoutePath("sitemap.xml.ts"), "/sitemap.xml");
  assert.equal(toRoutePath("feed/google-catalog.xml.ts"), "/feed/google-catalog.xml");
  assert.equal(toRoutePath("api/v1/openapi.json.ts"), "/api/v1/openapi.json");
});

test("the API families are told apart, longest prefix first", () => {
  // `/api/admin/...` and `/api/v1/...` both start with `/api/`, so an ordering
  // mistake here would file every admin endpoint as a public one.
  assert.equal(classify("/api/admin/orders/[id]"), "Admin API");
  assert.equal(classify("/api/v1/products/index"), "Headless API");
  assert.equal(classify("/api/webhooks/autolaris"), "Webhook");
  assert.equal(classify("/api/submit-order"), "Public API");
  assert.equal(classify("/admin/dashboard"), "Admin page");
  assert.equal(classify("/produk/[slug]"), "Storefront");
});

test("auth is reported from the family, and every token-guarded route says which token", () => {
  assert.equal(authFor("/produk", "Storefront"), "public");
  assert.equal(authFor("/admin/orders", "Admin page"), "admin session");
  assert.equal(authFor("/api/v1/checkout", "Headless API"), "api key");
  assert.equal(classify("/api/ops/v1/orders"), "Operations API");
  assert.equal(authFor("/api/ops/v1/orders", "Operations API"), "api key", "the ops API is never public");
  assert.equal(authFor("/api/webhooks/autolaris/[token]", "Webhook"), "webhook token");
  assert.equal(authFor("/api/handoff", classify("/api/handoff")), "handoff token");
  assert.equal(authFor("/api/owner-recovery", classify("/api/owner-recovery")), "recovery token");
  // The single-store install path is gone (T-21): no route may claim it.
  assert.equal(buildRouteMap().some((route) => /install/.test(route.path)), false);
});

test("platform routes are their own families, and their auth is asked of the platform guard", () => {
  assert.equal(classify("/platform/site"), "Platform site");
  assert.equal(classify("/platform/site/harga"), "Platform site");
  assert.equal(classify("/platform/signup"), "Platform site");
  assert.equal(classify("/platform/[...section]"), "Platform admin");
  assert.equal(classify("/platform/login"), "Platform admin");
  assert.equal(classify("/api/platform/tenants/[id]/[action]"), "Platform API");
  const routes = new Map(buildRouteMap().map((route) => [route.path, route]));
  // Guarded by a platform session, reachable by both platform roles (per-operation limits are ACTION_ROLES').
  for (const path of ["/platform/[...section]", "/api/platform/tenants", "/api/platform/tenants/[id]/[action]", "/api/platform/invoices/[id]/check", "/api/platform/logout"]) {
    assert.equal(routes.get(path)?.auth, "platform session", path);
    assert.deepEqual(routes.get(path)?.roles, ["platform_owner", "platform_support"], path);
  }
  // T-52 (UX-10): the team API is platform_owner only (the console page answers 403 to support).
  for (const path of ["/api/platform/team", "/api/platform/team/[id]"]) {
    assert.equal(routes.get(path)?.auth, "platform session", path);
    assert.deepEqual(routes.get(path)?.roles, ["platform_owner"], path);
  }
  // The signup, sign-in and marketing surfaces are public, exactly as the guard lets them through.
  for (const path of ["/platform/site", "/platform/signup", "/platform/login", "/api/platform/signup", "/api/platform/slug", "/api/platform/login"]) {
    assert.equal(routes.get(path)?.auth, "public", path);
    assert.deepEqual(routes.get(path)?.roles, [], path);
  }
  // A marketing page names the public URL it answers on.
  assert.equal(routes.get("/platform/site")?.servedAt, "/");
  assert.equal(routes.get("/platform/signup")?.servedAt, "/daftar");
  // Nothing under /platform is filed as a storefront or public API page any more.
  for (const route of routes.values()) {
    if (route.path.startsWith("/platform") || route.path.startsWith("/api/platform")) {
      assert.match(route.family, /^Platform /, route.path);
    }
  }
});

test("platform modules and control-plane tables are in the dictionary", () => {
  const routes = new Map(buildRouteMap().map((route) => [route.path, route]));
  const action = routes.get("/api/platform/tenants/[id]/[action]")!;
  assert.ok(action.libs.includes("platform/admin/tenants"), "a platform route lists its platform modules");
  assert.ok(action.platformTables.includes("tenants"), "and the PLATFORM_DB tables those modules name");
  // platform/admin/tenants has no sibling test: it is proven by the integration suites importing it.
  assert.ok(action.tests.includes("src/platform/two-tenants.test.ts"), "and the tests that import them");
  const platformTables = knownTables("src/platform/migrations");
  for (const table of ["tenants", "tenant_hosts", "platform_users", "tenant_events", "operator_notices"]) {
    assert.ok(platformTables.has(table), table);
  }
  // Every non-test platform module is indexed; test scaffolding is not.
  const modules = buildModuleMap([...routes.values()]).map((m) => m.name);
  for (const name of ["platform/gate", "platform/admin/guard", "platform/site/site", "platform/notify", "lib/route-map".replace("lib/", "")]) {
    assert.ok(modules.includes(name), name);
  }
  assert.equal(modules.some((name) => name.startsWith("platform/testing/")), false);
});

test("an endpoint reports the verbs it exports, a page reports GET", () => {
  const source = "export const GET = 1; export const OPTIONS = 2; export const POST = 3;";
  assert.deepEqual(methodsOf(source, "api/thing.ts"), ["GET", "OPTIONS", "POST"]);
  assert.deepEqual(methodsOf("const GET = 1;", "produk/index.astro"), ["GET"]);
});

/**
 * The reason this file exists. `doc/route-map.xml` is committed, so it is only
 * worth reading if it cannot fall behind `src/pages/`. Add a page without
 * running `npm run route-map` and this fails, naming the route you added.
 */
test("the committed route map still matches the filesystem", () => {
  const generated = toXml(buildRouteMap(), CMS_VERSION.version);
  const committed = readFileSync(new URL("../../doc/route-map.xml", import.meta.url), "utf8");
  const paths = (xml: string) => [...xml.matchAll(/<route path="([^"]+)"/g)].map((m) => m[1]);
  const added = paths(generated).filter((route) => !paths(committed).includes(route));
  const removed = paths(committed).filter((route) => !paths(generated).includes(route));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    "run `npm run route-map` — src/pages and doc/route-map.xml disagree",
  );
  assert.equal(generated, committed, "run `npm run route-map` to regenerate the map");
});

test("the dictionary columns are derived, and only from what exists", () => {
  // Imports resolve by name, whatever the relative depth.
  const source = `
    import { a } from "../../lib/order-persistence";
    import { b } from '../../../../lib/click-ids.ts';
    import Layout from "../../layouts/AdminLayout.astro";
    const sql = "SELECT id FROM orders o JOIN order_items oi UPDATE stores INSERT INTO nowhere";
    export function persist() {}
    export const LIMIT = 1;
    export type Row = {};
  `;
  assert.deepEqual(libImportsOf(source), ["click-ids", "order-persistence"]);
  // A table is only a table if a migration created it: `nowhere` is dropped,
  // so a typo in SQL cannot mint a phantom dependency in the map.
  const known = new Set(["orders", "order_items", "stores"]);
  assert.deepEqual(tablesOf(source, known), ["order_items", "orders", "stores"]);
  assert.deepEqual(exportsOf(source), ["LIMIT", "Row", "persist"]);
  // The real migrations: the rebuild scratch table never counts.
  const tables = knownTables();
  assert.ok(tables.has("orders") && tables.has("landing_sections"));
  assert.equal(tables.has("landing_sections_next"), false);
});

/**
 * PR-1. Astro compiles these into a page, and `listPageFiles` reads only
 * `.astro` and `.ts`, so such a file is a live URL the map never lists: an
 * internal note at `src/pages/landing/README.md` answered 200 on
 * `/landing/README` on every store. The guard refuses the file instead of
 * teaching the map to list it. `.html` is not in PR-1's list but Astro routes
 * it the same way.
 */
const UNMAPPED_ROUTABLE = ["md", "markdown", "mdown", "mkdn", "mkd", "mdwn", "mdx", "js", "html"];

/** Files Astro would route but the map would not list. `_` excludes a file or a folder, as in Astro. */
function unmappedRoutableFiles(dir: string): string[] {
  const routable = new RegExp(`\\.(${UNMAPPED_ROUTABLE.join("|")})$`);
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith("_")) return [];
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      // `statSync` follows a symlink: a linked folder is walked like a real one.
      if (statSync(join(current, entry.name)).isDirectory()) return walk(join(current, entry.name), relative);
      return routable.test(entry.name) ? [relative] : [];
    });
  return walk(dir, "").sort();
}

test("a routable file the map cannot list is refused, unless `_` keeps it out of the router", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-guard-"));
  try {
    mkdirSync(join(dir, "landing"));
    mkdirSync(join(dir, "_drafts"));
    writeFileSync(join(dir, "index.astro"), "");
    writeFileSync(join(dir, "robots.txt.ts"), "");
    for (const extension of UNMAPPED_ROUTABLE) {
      writeFileSync(join(dir, "landing", `README.${extension}`), "");
      writeFileSync(join(dir, "landing", `_README.${extension}`), "");
      writeFileSync(join(dir, "_drafts", `note.${extension}`), "");
    }
    // A folder linked in from elsewhere is still a folder of pages.
    const linked = mkdtempSync(join(tmpdir(), "route-guard-linked-"));
    writeFileSync(join(linked, "internal.md"), "");
    symlinkSync(linked, join(dir, "notes"));
    try {
      assert.deepEqual(
        unmappedRoutableFiles(dir),
        [...UNMAPPED_ROUTABLE.map((extension) => `landing/README.${extension}`), "notes/internal.md"].sort(),
      );
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no file under src/pages compiles into a page the route map does not list", () => {
  assert.deepEqual(
    unmappedRoutableFiles(PAGES_DIR),
    [],
    "Astro serves these as pages and doc/route-map.xml cannot list them: move the file out of src/pages or prefix it with `_`",
  );
});
