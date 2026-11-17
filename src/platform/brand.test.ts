// T-29 (PR-18, UI-1, UI-3): the platform brand is adsbook.id; a seller host
// shows the seller's brand plus one footer link, and loads no platform tag.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { installRouteSlugs, nativeLandingPages } from "../data/native-landing-pages.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SRC = join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const SOURCES = files(SRC)
  .filter((path) => /\.(astro|tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.includes("/db/migrations/"))
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

/**
 * Old-brand strings that never render: browser-storage and KV keys an upgraded
 * store still holds (renaming them would re-send alerts and notifications),
 * and comments describing the old fleet.
 */
const LEGACY = new Map<string, string[]>([
  ["src/components/admin/NotificationBell.tsx", ['"adsbookcms:notified:v1"', '"adsbookcms:notify-asked:v1"']],
  ["src/components/admin/OperationalStatusIcon.tsx", ['"adsbookcms:ops-status:v1"', '"adsbookcms:ops-status"']],
  ["src/lib/operational-alerts.ts", ['"adsbookcms:operational-alert:v1:"']],
  ["src/lib/click-ids.ts", ["before the AdsBookCMS rename"]],
  ["src/lib/deploy-preflight.ts", ["`adsbookcms-your-store`", "`adsbookcms-your-store`"]],
]);

test("no source the product renders carries the old AdsBookCMS name", () => {
  const offenders: string[] = [];
  for (const { path, text } of SOURCES) {
    let rest = text;
    for (const allowed of LEGACY.get(path) ?? []) rest = rest.replace(allowed, "");
    for (const match of rest.matchAll(/adsbookcms/gi)) offenders.push(`${path}: …${rest.slice(Math.max(0, match.index - 30), match.index + 30)}…`);
  }
  assert.deepEqual(offenders, []);
});

test("UI-1: the storefront footer's only platform mark is the 'Dibuat dengan adsbook.id' link", () => {
  const footer = readFileSync(join(SRC, "components/storefront/shared/SiteFooter.astro"), "utf8");
  assert.match(footer, /href="https:\/\/adsbook\.id"[\s\S]{0,300}>Dibuat dengan adsbook\.id<\/a>/);
  assert.doesNotMatch(footer, /ongki\.pro/);
  assert.match(footer, /© \{new Date\(\)\.getFullYear\(\)\} \{Astro\.locals\.tenant\.name\}/, "the copyright is the store's");
});

test("UI-3: platform tags and copy are reachable only from platform pages", () => {
  // The platform site, its Pixel and its secrets live under src/platform/ and
  // the /platform pages; a seller host never routes there (middleware gate).
  const allowed = (path: string) =>
    path.startsWith("src/platform/") || path.startsWith("src/pages/platform/") || path.startsWith("src/components/platform/") ||
    path === "src/pages/api/platform/signup.ts" || path === "src/env.d.ts" ||
    // Tooling that classifies /platform routes for doc/ROUTE-MAP.md; never in the Worker (checked below).
    path === "src/lib/route-map.ts";
  const reaching = SOURCES.filter(({ path, text }) => !allowed(path) && /platform\/site\/|PlatformPixel|PLATFORM_META_/.test(text)).map(({ path }) => path);
  assert.deepEqual(reaching, []);
  const importsRouteMap = SOURCES.filter(({ path, text }) => path !== "src/lib/route-map.ts" && /from\s+["'][^"']*route-map(\.ts)?["']/.test(text)).map(({ path }) => path);
  assert.deepEqual(importsRouteMap, [], "route-map is tooling: no product source may import it");
  for (const layout of ["src/layouts/BaseLayout.astro", "src/components/storefront/shared/SiteFooter.astro"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, layout), "utf8"), /PLATFORM_|platformPixel|fbq\('init', *['"]\d/, layout);
  }
});

test("the native landing register is empty: a native page would answer on every seller host", () => {
  // Add an entry here and this fails on purpose (PRD non-goal: a compiled page
  // is shared by every tenant, so it can only ever carry one merchant's copy).
  assert.deepEqual(nativeLandingPages, []);
  assert.deepEqual(installRouteSlugs, []);
});

test("the inherited sample route and the QRIS tip panel are gone", () => {
  assert.equal(existsSync(join(SRC, "pages/contoh-landing.astro")), false);
  assert.equal(existsSync(join(ROOT, "public/images/qris-dukung-adsbookcms.svg")), false);
  assert.doesNotMatch(readFileSync(join(ROOT, "doc/ROUTE-MAP.md"), "utf8"), /contoh-landing/);
  assert.doesNotMatch(readFileSync(join(SRC, "pages/hello.astro"), "utf8"), /QRIS|ongki/i);
  // The old fleet owner's poster was every store's phone login background.
  assert.equal(existsSync(join(ROOT, "public/images/login-bg-mobile.webp")), false);
  assert.doesNotMatch(readFileSync(join(SRC, "styles/admin.css"), "utf8"), /login-bg-mobile|qris/i);
});

test("the legacy open-book icon is replaced by the precision mark and wordmark everywhere", () => {
  for (const asset of [
    "public/images/adsbook-icon.svg",
    "public/images/logo.svg",
    "public/images/adsbook-wordmark.svg",
    "public/images/adsbook-wordmark-on-dark.svg",
  ]) {
    assert.equal(existsSync(join(ROOT, asset)), true, `${asset} exists`);
    assert.doesNotMatch(readFileSync(join(ROOT, asset), "utf8"), /M184 306/, `${asset} has no open-book path`);
  }
});
