/**
 * The route surface, derived from `src/pages/` rather than described by hand.
 *
 * ARCHITECTURE.md §3 summarises this surface in prose ("`/admin/*` — 27 pages").
 * Prose drifts: there are 28 admin pages today, and the section still describes
 * a 41-file migration chain that is now 52. A map you have to remember to
 * update is a map that lies, so this one is generated and drift-tested instead
 * (`npm run route-map`, `src/lib/route-map.test.ts`).
 *
 * It answers the questions an audit actually asks, in the order it asks them:
 * which file serves this URL (and, for the marketing site, which public URL),
 * who may reach it, which `src/lib` and `src/platform` modules it leans on,
 * which tables that surface touches — the tenant's own store
 * (`src/db/migrations`) and the control plane `PLATFORM_DB`
 * (`src/platform/migrations`) — and which test would catch a regression. Table
 * names come from `CREATE TABLE` in those migrations, so a name that appears in
 * SQL but was never created is not silently invented here.
 *
 * Who may reach a platform route is asked of the platform guard
 * (`isPlatformPublicPath`) and of `ACTION_ROLES`, as admin roles are asked of
 * `canAccessAdminRoute`: the map moves when the code moves.
 *
 * Table attribution is one level deep — a route's own SQL plus the SQL of the
 * modules it imports directly. Deeper chains exist (a lib importing a lib) and
 * are deliberately not followed: the map names where to look, it does not
 * replace reading the code.
 *
 * Nothing in the Worker imports this module. It is tooling: the generator
 * script and its test are the only consumers, so it never reaches the bundle.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { ADMIN_ROLES, canAccessAdminRoute } from "./auth.ts";
import { isPlatformPublicPath } from "../platform/admin/guard.ts";
import { ACTION_ROLES } from "../platform/admin/tenants.ts";
import { isOwnerOnlyPlatformPath } from "../platform/admin/team.ts";
import { PLATFORM_SITE_ROUTES } from "../platform/host.ts";

export const PAGES_DIR = "src/pages";

export type RouteFamily =
  | "Storefront"
  | "Content page"
  | "Landing page"
  | "Checkout form"
  | "Sign-in & recovery"
  | "Feed"
  | "Media"
  | "Admin page"
  | "Admin API"
  | "Public API"
  | "Headless API"
  | "Operations API"
  | "Webhook"
  | "Platform site"
  | "Platform admin"
  | "Platform API";

export type RouteAuth =
  | "public"
  | "admin session"
  | "api key"
  | "platform session"
  | "webhook token"
  | "handoff token"
  | "recovery token";

export type RouteEntry = {
  path: string;
  file: string;
  family: RouteFamily;
  methods: string[];
  auth: RouteAuth;
  /** Empty unless the route is role-gated: admin roles, or platform roles. */
  roles: string[];
  /** The public URL on platform hosts, for a marketing-site page served by rewrite. */
  servedAt?: string;
  /** Modules the route imports directly: `src/lib` by name, `src/platform` as `platform/<path>`. */
  libs: string[];
  /** Tenant-store tables (`src/db/migrations`) named in the route's SQL and its direct modules' SQL. */
  tables: string[];
  /** Control-plane tables (`PLATFORM_DB`, `src/platform/migrations`) named the same way. */
  platformTables: string[];
  /** Tests of those modules — each one's sibling `*.test.ts` and every test file importing it directly. */
  tests: string[];
};

export type ModuleEntry = {
  name: string;
  file: string;
  exports: string[];
  tables: string[];
  platformTables: string[];
  /** Its sibling test first, then every test file that imports it directly; empty when none does. */
  tests: string[];
  /** Route paths that import this module directly. */
  usedBy: string[];
};

export const LIB_DIR = "src/lib";
export const PLATFORM_DIR = "src/platform";
export const MIGRATIONS_DIR = "src/db/migrations";
export const PLATFORM_MIGRATIONS_DIR = "src/platform/migrations";

/** The order families are presented in — public surface first, operator last. */
export const FAMILY_ORDER: readonly RouteFamily[] = [
  "Storefront",
  "Content page",
  "Landing page",
  "Checkout form",
  "Feed",
  "Media",
  "Sign-in & recovery",
  "Public API",
  "Headless API",
  "Operations API",
  "Webhook",
  "Admin page",
  "Admin API",
  "Platform site",
  "Platform admin",
  "Platform API",
] as const;

/** Marketing-site pages and the public pages beside them (served on platform hosts). */
const PLATFORM_SITE_PAGES = new Set(["/platform/signup", "/platform/masuk", "/platform/syarat", "/platform/privasi"]);

/** `/platform/site` → `/`: the public URL each rewritten marketing page answers on. */
const SERVED_AT = new Map(Object.entries(PLATFORM_SITE_ROUTES).map(([url, page]) => [page, url]));

const CONTENT_PAGES = new Set([
  "/tentang",
  "/kontak",
  "/testimoni",
  "/sitemap",
  "/disclaimer",
  "/kebijakan-privasi",
  "/kebijakan-cookie",
  "/syarat-ketentuan",
  "/pengiriman",
]);

const CHECKOUT_FORMS = new Set([
  "/hybrid-form",
  "/middle-form",
  "/full-form",
  "/geoipform",
  "/embed/form",
  // Query-preserving 308s to the three above. They exist as files, so they
  // belong on the map — their absence is what made someone add them twice.
  "/form-hybrid",
  "/form-middle",
  "/form-full",
]);

const LANDING_PAGES = new Set(["/[slug]", "/solusi-terbaru", "/landing-page"]);

/**
 * `src/pages/admin/orders/[invoice].astro` → `/admin/orders/[invoice]`.
 *
 * Astro's own bracket syntax is kept rather than translated to `:param`,
 * because the point of this map is to get from a URL back to a file.
 */
export function toRoutePath(relativeFile: string): string {
  const withoutExtension = relativeFile.replace(/\.(astro|ts)$/, "");
  // `robots.txt.ts` → `robots.txt`, `feed/x.xml.ts` → `feed/x.xml`: only the
  // final extension is a file extension, the rest is part of the URL.
  const trimmed = withoutExtension.replace(/\/index$/, "");
  if (trimmed === "index" || trimmed === "") return "/";
  return `/${trimmed}`;
}

export function classify(path: string): RouteFamily {
  if (path === "/api/platform" || path.startsWith("/api/platform/")) return "Platform API";
  if (path === "/platform/site" || path.startsWith("/platform/site/") || PLATFORM_SITE_PAGES.has(path)) return "Platform site";
  if (path === "/platform" || path.startsWith("/platform/")) return "Platform admin";
  if (path.startsWith("/api/admin")) return "Admin API";
  if (path.startsWith("/api/v1")) return "Headless API";
  if (path.startsWith("/api/ops/")) return "Operations API";
  if (path.startsWith("/api/webhooks")) return "Webhook";
  if (path === "/api/handoff" || path === "/api/owner-recovery") return "Sign-in & recovery";
  if (path.startsWith("/api/")) return "Public API";
  if (path.startsWith("/admin")) return "Admin page";
  if (path.startsWith("/assets/") || path.startsWith("/media/")) return "Media";
  if (path.startsWith("/feed/") || path === "/sitemap.xml" || path === "/robots.txt") return "Feed";
  if (path === "/hello" || path === "/pemulihan") return "Sign-in & recovery";
  if (CHECKOUT_FORMS.has(path)) return "Checkout form";
  if (CONTENT_PAGES.has(path)) return "Content page";
  if (LANDING_PAGES.has(path)) return "Landing page";
  return "Storefront";
}

export function authFor(path: string, family: RouteFamily): RouteAuth {
  if (family === "Admin page" || family === "Admin API") return "admin session";
  if (family === "Headless API" || family === "Operations API") return "api key";
  if (family === "Webhook") return "webhook token";
  if (family === "Platform site" || family === "Platform admin" || family === "Platform API") {
    return isPlatformPublicPath(path) ? "public" : "platform session";
  }
  if (path === "/api/handoff") return "handoff token";
  if (path === "/api/owner-recovery") return "recovery token";
  return "public";
}

/** Every platform role that passes the guard; per-operation limits come from `ACTION_ROLES`. */
const PLATFORM_ROLES = [...new Set(Object.values(ACTION_ROLES).flat())].sort();

/**
 * Which roles reach a route, asked of `canAccessAdminRoute` and of the platform
 * guard and `ACTION_ROLES` rather than copied out of them. A grant that moves
 * in the code moves here on the next generate, and the drift test fails until
 * someone regenerates.
 */
export function rolesFor(path: string, family: RouteFamily): string[] {
  if (family === "Admin page" || family === "Admin API") return ADMIN_ROLES.filter((role) => canAccessAdminRoute(role, path));
  if (authFor(path, family) === "platform session") return isOwnerOnlyPlatformPath(path.replace(/\/\[id\]$/, "/x")) ? ["platform_owner"] : [...PLATFORM_ROLES];
  return [];
}

const METHOD_EXPORT = /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|ALL)\b/g;

export function methodsOf(source: string, file: string): string[] {
  // An `.astro` page is a document: it answers GET and nothing else.
  if (file.endsWith(".astro")) return ["GET"];
  const found = new Set<string>();
  for (const match of source.matchAll(METHOD_EXPORT)) found.add(match[1]);
  return [...found].sort();
}

const LIB_IMPORT = /from\s+["'](?:\.\.\/)+lib\/([a-z0-9-]+)(?:\.ts)?["']/g;
const PLATFORM_IMPORT = /from\s+["'](?:\.\.\/)+platform\/([a-z0-9/-]+?)(?:\.ts)?["']/g;
const SQL_TABLE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+`?([a-z_]+)`?/g;
const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?`?([a-z_]+)`?/g;
const EXPORTED = /^\s*export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z0-9_]+)/gm;

/** Tables the migrations actually create. `*_next` is a rebuild scratch name. */
export function knownTables(dir: string = MIGRATIONS_DIR): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(CREATE_TABLE)) {
      if (!m[1].endsWith("_next")) names.add(m[1]);
    }
  }
  return names;
}

/** Direct imports of `src/lib` (by name) and `src/platform` (as `platform/<path>`). */
export function libImportsOf(source: string): string[] {
  return [
    ...new Set([
      ...[...source.matchAll(LIB_IMPORT)].map((m) => m[1]),
      ...[...source.matchAll(PLATFORM_IMPORT)].map((m) => `platform/${m[1]}`),
    ]),
  ].sort();
}

export function tablesOf(source: string, known: Set<string>): string[] {
  return [...new Set([...source.matchAll(SQL_TABLE)].map((m) => m[1]).filter((t) => known.has(t)))].sort();
}

export function exportsOf(source: string): string[] {
  return [...new Set([...source.matchAll(EXPORTED)].map((m) => m[1]))].sort();
}

const isModule = (file: string) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts");

/**
 * Every non-test module the map indexes, keyed by its import name: `src/lib`
 * flat (`auth`), `src/platform` recursive (`platform/admin/guard`). Test
 * scaffolding under `src/platform/testing` is not a module of the product.
 */
export function listLibModules(dir: string = LIB_DIR, platformDir: string = PLATFORM_DIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(dir).sort()) {
    if (isModule(file)) out.set(file.replace(/\.ts$/, ""), `${dir}/${file}`);
  }
  if (!existsSync(platformDir)) return out;
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "testing" && entry.name !== "migrations") walk(join(current, entry.name), relative);
      } else if (isModule(entry.name)) {
        out.set(`platform/${relative.replace(/\.ts$/, "")}`, `${platformDir}/${relative}`);
      }
    }
  };
  walk(platformDir, "");
  return out;
}

const SPECIFIER = /(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Every `*.test.ts` under `src`, as a repository path. */
function listTestFiles(root = "src"): string[] {
  const walk = (current: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const next = join(current, entry.name);
      if (entry.isDirectory()) return walk(next);
      return entry.name.endsWith(".test.ts") ? [next] : [];
    });
  return existsSync(root) ? walk(root).sort() : [];
}

/**
 * Module file → the tests that cover it: its sibling `*.test.ts`, then every
 * test file importing it directly (static or `await import`). Platform modules
 * are mostly proven by integration suites rather than siblings, and a map that
 * read siblings only would call them untested.
 */
function testsByModuleFile(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (file: string, test: string) => {
    const list = out.get(file) ?? [];
    if (!list.includes(test)) list.push(test);
    out.set(file, list);
  };
  for (const test of listTestFiles()) {
    const sibling = test.replace(/\.test\.ts$/, ".ts");
    if (existsSync(sibling)) add(sibling, test);
  }
  for (const test of listTestFiles()) {
    for (const match of readFileSync(test, "utf8").matchAll(SPECIFIER)) {
      let target = relative(process.cwd(), resolve(dirname(test), match[1]));
      if (!target.endsWith(".ts")) target = `${target}.ts`;
      if (target !== test && existsSync(target)) add(target, test);
    }
  }
  return out;
}

/** Every page file under `dir`, relative to it, sorted. */
export function listPageFiles(dir: string = PAGES_DIR): string[] {
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const next = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(next, relative);
      return /\.(astro|ts)$/.test(entry.name) ? [relative] : [];
    });
  return walk(dir, "").sort();
}

export function buildRouteMap(dir: string = PAGES_DIR): RouteEntry[] {
  const known = knownTables();
  const knownPlatform = knownTables(PLATFORM_MIGRATIONS_DIR);
  const modules = listLibModules();
  const covering = testsByModuleFile();
  const libSource = new Map<string, string>();
  const readLib = (name: string) => {
    if (!libSource.has(name)) libSource.set(name, readFileSync(modules.get(name)!, "utf8"));
    return libSource.get(name)!;
  };
  return listPageFiles(dir)
    .map((relative) => {
      const path = toRoutePath(relative);
      const family = classify(path);
      const source = readFileSync(join(dir, relative), "utf8");
      // Only libs that exist on disk: a stale import would otherwise be listed
      // as a dependency and, worse, be looked up for its SQL.
      const libs = libImportsOf(source).filter((name) => modules.has(name));
      const tables = new Set(tablesOf(source, known));
      const platformTables = new Set(tablesOf(source, knownPlatform));
      for (const name of libs) {
        for (const t of tablesOf(readLib(name), known)) tables.add(t);
        for (const t of tablesOf(readLib(name), knownPlatform)) platformTables.add(t);
      }
      const tests = [...new Set(libs.flatMap((name) => covering.get(modules.get(name)!) ?? []))].sort();
      const servedAt = SERVED_AT.get(path);
      return {
        path,
        file: `${dir}/${relative}`,
        family,
        methods: methodsOf(source, relative),
        auth: authFor(path, family),
        roles: rolesFor(path, family),
        ...(servedAt ? { servedAt } : {}),
        libs,
        tables: [...tables].sort(),
        platformTables: [...platformTables].sort(),
        tests,
      };
    })
    .sort((a, b) => {
      const byFamily = FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family);
      return byFamily !== 0 ? byFamily : a.path.localeCompare(b.path);
    });
}

export function buildModuleMap(routes: RouteEntry[]): ModuleEntry[] {
  const known = knownTables();
  const knownPlatform = knownTables(PLATFORM_MIGRATIONS_DIR);
  const covering = testsByModuleFile();
  return [...listLibModules()].map(([name, file]) => {
    const source = readFileSync(file, "utf8");
    return {
      name,
      file,
      exports: exportsOf(source),
      tables: tablesOf(source, known),
      platformTables: tablesOf(source, knownPlatform),
      tests: covering.get(file) ?? [],
      usedBy: routes.filter((r) => r.libs.includes(name)).map((r) => r.path),
    };
  });
}

/** Table names both chains create: a mention of one cannot say which database it means. */
export function sharedTableNames(): string[] {
  const platform = knownTables(PLATFORM_MIGRATIONS_DIR);
  return [...knownTables()].filter((name) => platform.has(name)).sort();
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toXml(routes: RouteEntry[], version: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- Generated by `npm run route-map`. Do not edit by hand. -->",
    `<route-map version="${escape(version)}" routes="${routes.length}" source="${PAGES_DIR}">`,
  ];
  for (const family of FAMILY_ORDER) {
    const inFamily = routes.filter((route) => route.family === family);
    if (inFamily.length === 0) continue;
    lines.push(`  <family name="${escape(family)}" count="${inFamily.length}">`);
    for (const route of inFamily) {
      const roles = route.roles.length > 0 ? ` roles="${route.roles.join(",")}"` : "";
      const served = route.servedAt ? ` served-at="${escape(route.servedAt)}"` : "";
      const opt = (k: string, v: string[]) => (v.length > 0 ? ` ${k}="${escape(v.join(","))}"` : "");
      lines.push(
        `    <route path="${escape(route.path)}"${served} methods="${route.methods.join(",")}"` +
          ` auth="${escape(route.auth)}"${roles} file="${escape(route.file)}"` +
          `${opt("libs", route.libs)}${opt("tables", route.tables)}${opt("platform-tables", route.platformTables)}${opt("tests", route.tests)}/>`,
      );
    }
    lines.push("  </family>");
  }
  const modules = buildModuleMap(routes);
  lines.push(`  <modules count="${modules.length}" source="${LIB_DIR} ${PLATFORM_DIR}">`);
  for (const m of modules) {
    const opt = (k: string, v: string[]) => (v.length > 0 ? ` ${k}="${escape(v.join(","))}"` : "");
    lines.push(
      `    <module name="${escape(m.name)}" file="${escape(m.file)}"` +
        ` tests="${m.tests.length > 0 ? escape(m.tests.join(",")) : "none"}"` +
        `${opt("exports", m.exports)}${opt("tables", m.tables)}${opt("platform-tables", m.platformTables)}${opt("used-by", m.usedBy)}/>`,
    );
  }
  lines.push("  </modules>");
  lines.push("</route-map>", "");
  return lines.join("\n");
}

export function toMarkdown(routes: RouteEntry[], version: string): string {
  const list = (v: string[]) => (v.length > 0 ? v.map((x) => `\`${x}\``).join(" ") : "—");
  const lines = [
    "# Route Map",
    "",
    "> Generated by `npm run route-map` from `src/pages/`. Do not edit by hand —",
    "> `src/lib/route-map.test.ts` fails when this file and the filesystem disagree.",
    "",
    `adsbook.id ${version} — **${routes.length} routes** across ${
      new Set(routes.map((route) => route.family)).size
    } families.`,
    "",
    "`auth` is the boundary a request crosses, not a promise that the route is safe:",
    "`admin session` means the middleware requires a seller's signed session, and `roles`",
    "lists which seller roles `canAccessAdminRoute` admits. `platform session` means the",
    "platform guard requires a platform operator (`/platform/*`, `/api/platform/*`, platform",
    "hosts only); its `roles` are the platform roles that pass the guard, and a tenant action",
    "is further limited per operation by `ACTION_ROLES` (`src/platform/admin/tenants.ts`).",
    "`webhook token`, `handoff token` and `recovery token` are single-purpose tokens in the",
    "request; `api key` is a tenant's Headless or Operations API key.",
    "",
    "A marketing-site page renders from `src/pages/platform/…` but answers on a platform host",
    "at its public URL, shown as `page ⇐ public URL` (`PLATFORM_SITE_ROUTES`).",
    "",
    "Read it as a dictionary, left to right: **URL → file → modules → tables → tests**.",
    "`modules` are the `src/lib` modules (by name) and `src/platform` modules (as",
    "`platform/<path>`) the file imports directly. `store tables` are the tenant store's",
    "tables (`src/db/migrations`), `platform tables` the control plane's `PLATFORM_DB`",
    "(`src/platform/migrations`), each named in that file's SQL and in those modules' SQL",
    "(one level, not deeper). `tests` are the test files that cover those modules — each one's",
    "sibling and every test importing it directly — the first place a regression shows. A route",
    "with no `tests` is a route whose behaviour only a browser can prove. The [Modules](#modules)",
    "section is the same book read from the other side.",
    "",
    `Table names both chains create (${sharedTableNames().map((name) => `\`${name}\``).join(", ") || "none"}) appear`,
    "under both headings wherever they are named; which database a statement meant is in the code.",
    "",
  ];
  for (const family of FAMILY_ORDER) {
    const inFamily = routes.filter((route) => route.family === family);
    if (inFamily.length === 0) continue;
    lines.push(`## ${family} (${inFamily.length})`, "");
    lines.push("| Route | Methods | Auth | Roles | File | Modules | Store tables | Platform tables | Tests |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const route of inFamily) {
      const url = route.servedAt ? `\`${route.path}\` ⇐ \`${route.servedAt}\`` : `\`${route.path}\``;
      lines.push(
        `| ${url} | ${route.methods.join(", ") || "—"} | ${route.auth} | ${
          route.roles.length > 0 ? route.roles.join(", ") : "—"
        } | \`${route.file}\` | ${list(route.libs)} | ${list(route.tables)} | ${list(route.platformTables)} | ${list(
          route.tests.map((t) => t.replace(/^src\//, "")),
        )} |`,
      );
    }
    lines.push("");
  }
  const modules = buildModuleMap(routes);
  const untested = modules.filter((m) => m.tests.length === 0);
  lines.push(
    "## Modules",
    "",
    `${modules.length} modules under \`${LIB_DIR}\` and \`${PLATFORM_DIR}\`; ${untested.length} that no test imports.`,
    "`tests` counts a module's sibling test and every test file importing it directly.",
    "`used by` lists routes importing the module directly — a module used by nothing",
    "is either transitive (imported by another lib) or dead, and only reading tells which.",
    "",
    "| Module | Exports | Store tables | Platform tables | Test | Used by |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const m of modules) {
    lines.push(
      `| \`${m.name}\` | ${m.exports.length} | ${list(m.tables)} | ${list(m.platformTables)} | ${
        m.tests.length > 0 ? String(m.tests.length) : "**none**"
      } | ${m.usedBy.length > 0 ? m.usedBy.map((p) => `\`${p}\``).join(" ") : "—"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
