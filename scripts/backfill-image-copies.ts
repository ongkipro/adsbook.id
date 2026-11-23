// Gives a store's pre-2026-11-18 uploads the two copies every later upload
// already has (owner, 2026-11-23: "1024 jpeg aja … 480px untuk storefront
// public biar maksimal dan ringan"):
//   <key>-sm.webp  ≤ 480 px WebP, what the storefront shows (storefrontImageSrc)
//   <key>.jpg      ≤ 1024 px JPEG, what the catalog feeds link (feedImagePath;
//                  Meta takes JPEG or PNG only)
// Older uploads are 1024-1280 px WebP with neither, so the storefront shipped
// up to 207 KB per photo and the feeds' `.jpg` links were answered with WebP.
//
// It reads only public URLs (the store's feed, home, product list and
// sitemap), finds the uploads, and checks each copy through the asset route,
// which marks a fallback with `X-Asset-Stand-In`. The originals are never
// touched.
//
//   npm run backfill:images                      # every store, dry run
//   npm run backfill:images -- --apply           # every store, write
//   npm run backfill:images -- --host demo.adsbook.my.id --tenant <id>   # one store
//   … --apply     writes the missing copies with `wrangler r2 object put --remote`
//   … --replace-small-feed   also rewrites a stored `.jpg` under 500 px (padded to a square)
//
// By default it reads every tenant from PLATFORM_DB (read-only) and runs each
// store in turn at `<slug>.adsbook.my.id`, then prints one summary; --host and
// --tenant narrow it to one store. Without --apply it
// only reports. --apply is a production write: ask first
// (AGENTS.md §5).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { FEED_MIN_WIDTH } from "../src/lib/image-rules.ts";
import { encode } from "./prepare-image.ts";
import { DISPLAY_SIZED_SINCE } from "../src/lib/image-derivative.ts";
import { tenantR2Key } from "../src/platform/keys.ts";

const BUCKET = "adsbook-platform-media";
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const apply = process.argv.includes("--apply");
const replaceSmallFeed = process.argv.includes("--replace-small-feed");
const SELLER_ZONE = "adsbook.my.id";

type Store = { host: string; tenant: string };
function stores(): Store[] {
  if (!arg("host") && !arg("tenant")) {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "adsbook-platform", "--remote", "--json", "--command", "SELECT id, slug FROM tenants ORDER BY created_at"], { encoding: "utf8" });
    const rows = (JSON.parse(out)[0]?.results ?? []) as Array<{ id: string; slug: string }>;
    return rows.map((row) => ({ host: `${row.slug}.${SELLER_ZONE}`, tenant: row.id }));
  }
  const host = arg("host");
  const tenant = arg("tenant");
  if (!host || !tenant) {
    console.error("usage: [--host <store host> --tenant <tenant id>] [--apply] [--replace-small-feed]");
    process.exit(2);
  }
  return [{ host, tenant }];
}
const UPLOAD = /\/assets\/(uploads\/(\d{4}-\d{2}-\d{2})\/[0-9a-f-]+)(?:-sm)?\.(?:webp|jpg|png)/gi;

const dir = mkdtempSync(join(tmpdir(), "adsbook-backfill-"));
let origin = "";
const wideEnough = async (bytes: Buffer) => {
  const meta = await sharp(bytes).metadata().catch(() => ({ width: 0, height: 0 }));
  return Math.min(meta.width ?? 0, meta.height ?? 0) >= FEED_MIN_WIDTH;
};
async function text(path: string) {
  const response = await fetch(`${origin}${path}`, { headers: { "user-agent": "adsbook-backfill" } });
  return response.ok ? response.text() : "";
}

/**
 * True when the asset route answers with the object itself, not a fallback.
 * With --replace-small-feed a stored catalog JPEG under 500 px counts as missing.
 */
async function stored(key: string, type: string, tenant: string) {
  const response = await fetch(`${origin}/assets/${key}?backfill=${Date.now()}`, { method: "GET" });
  const bytes = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const own = response.ok && !response.headers.has("x-asset-stand-in") && (response.headers.get("content-type") || "").startsWith(type);
  if (!own || !replaceSmallFeed || type !== "image/jpeg") return own;
  if (await wideEnough(bytes)) return true;
  // The edge keeps an upload a day (UPLOAD_EDGE_CACHE_SECONDS), so a copy this
  // script already replaced can still look small from outside: ask R2 itself.
  const file = join(dir, `check-${Date.now()}.jpg`);
  try {
    execFileSync("npx", ["wrangler", "r2", "object", "get", `${BUCKET}/${tenantR2Key(tenant, key)}`, "--remote", "--file", file], { stdio: "ignore" });
    return await wideEnough(readFileSync(file));
  } catch {
    return false;
  }
}


let written = 0;
let missing = 0;
const unreachable: string[] = [];
async function backfill(host: string, tenant: string) {
  origin = `https://${host}`;
  // A store that is not live yet answers 503 on every page, so its uploads
  // cannot be found from outside; it has no buyers and no feed read yet.
  const probe = await fetch(`${origin}/feed/meta-catalog.xml`, { method: "GET" });
  await probe.arrayBuffer().catch(() => undefined);
  if (!probe.ok) {
    unreachable.push(`${host} (${probe.status})`);
    console.log(`\n${host}: not public (HTTP ${probe.status}), skipped`);
    return;
  }
  const pages = ["/feed/meta-catalog.xml", "/", "/produk", "/sitemap"];
  const sitemap = await text("/sitemap");
  for (const match of sitemap.matchAll(/href="(\/[a-z0-9-]+(?:\/[a-z0-9-]+)?)"/gi)) pages.push(match[1]);
  const bases = new Map<string, string>();
  for (const page of new Set(pages)) {
    for (const match of (await text(page)).matchAll(UPLOAD)) {
      if (match[2] < DISPLAY_SIZED_SINCE) bases.set(match[1], match[2]);
    }
  }

  console.log(`\n${host}: ${bases.size} upload(s) from before ${DISPLAY_SIZED_SINCE}${apply ? "" : " (dry run)"}`);
  for (const base of bases.keys()) {
    const copies = [
      { key: `${base}-sm.webp`, variant: "display" as const, type: "image/webp" },
      { key: `${base}.jpg`, variant: "feed" as const, type: "image/jpeg" },
    ];
    const needed = [];
    for (const copy of copies) if (!(await stored(copy.key, copy.type, tenant))) needed.push(copy);
    if (!needed.length) {
      console.log(`ok       ${base}`);
      continue;
    }
    const original = await fetch(`${origin}/assets/${base}.webp`);
    if (!original.ok) {
      console.log(`skip     ${base} (original ${original.status})`);
      continue;
    }
    const source = Buffer.from(await original.arrayBuffer());
    for (const copy of needed) {
      missing += 1;
      const bytes = await encode(source, copy.variant);
      const meta = await sharp(bytes).metadata();
      // Meta and Google refuse a catalog photo under 500 × 500: say so, the seller must re-shoot it.
      const small = copy.variant === "feed" && Math.min(meta.width ?? 0, meta.height ?? 0) < FEED_MIN_WIDTH ? "  ! under 500 px, catalogs will refuse it" : "";
      console.log(`${apply ? "write" : "missing"}  ${copy.key}  ${meta.width}x${meta.height}  ${Math.round(bytes.byteLength / 1024)} KB${small}`);
      if (!apply) continue;
      const file = join(dir, copy.key.replace(/\//g, "_"));
      writeFileSync(file, bytes);
      execFileSync("npx", [
        "wrangler", "r2", "object", "put", `${BUCKET}/${tenantR2Key(tenant, copy.key)}`,
        "--remote", "--file", file, "--content-type", copy.type,
        "--cache-control", "public, max-age=31536000, immutable",
      ], { stdio: "inherit" });
      written += 1;
    }
  }
}

for (const store of stores()) await backfill(store.host, store.tenant);
console.log(`\n${apply ? `${written} cop(ies) written` : `${missing} cop(ies) missing; re-run with --apply to write them`}`);
if (unreachable.length) console.log(`not public, re-run once live: ${unreachable.join(", ")}`);
