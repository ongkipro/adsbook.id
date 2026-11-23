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
//   node --experimental-strip-types scripts/backfill-image-copies.ts --host demo.adsbook.my.id --tenant <id>
//   … --apply     writes the missing copies with `wrangler r2 object put --remote`
//
// Without --apply it only reports. --apply is a production write: ask first
// (AGENTS.md §5).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { FEED_MIN_WIDTH, IMAGE_QUALITIES, IMAGE_VARIANTS, type ImageVariant } from "../src/lib/image-rules.ts";
import { DISPLAY_SIZED_SINCE } from "../src/lib/image-derivative.ts";
import { tenantR2Key } from "../src/platform/keys.ts";

const BUCKET = "adsbook-platform-media";
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const host = arg("host");
const tenant = arg("tenant");
const apply = process.argv.includes("--apply");
if (!host || !tenant) {
  console.error("usage: --host <store host> --tenant <tenant id> [--apply]");
  process.exit(2);
}
const origin = `https://${host}`;
const UPLOAD = /\/assets\/(uploads\/(\d{4}-\d{2}-\d{2})\/[0-9a-f-]+)(?:-sm)?\.(?:webp|jpg|png)/gi;

async function text(path: string) {
  const response = await fetch(`${origin}${path}`, { headers: { "user-agent": "adsbook-backfill" } });
  return response.ok ? response.text() : "";
}

/** True when the asset route answers with the object itself, not a fallback. */
async function stored(key: string, type: string) {
  const response = await fetch(`${origin}/assets/${key}?backfill=${Date.now()}`, { method: "GET" });
  await response.arrayBuffer().catch(() => undefined);
  return response.ok && !response.headers.has("x-asset-stand-in") && (response.headers.get("content-type") || "").startsWith(type);
}

async function encode(source: Buffer, variant: ImageVariant) {
  const rule = IMAGE_VARIANTS[variant];
  for (const quality of IMAGE_QUALITIES) {
    const pipeline = sharp(source).rotate().resize({ width: rule.maxWidth, withoutEnlargement: true });
    const out = rule.type === "image/webp"
      ? await pipeline.webp({ quality: Math.round(quality * 100) }).toBuffer()
      : await pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: Math.round(quality * 100), mozjpeg: true }).toBuffer();
    if (out.byteLength <= rule.maxBytes) return out;
  }
  throw new Error(`too detailed for the ${variant} budget`);
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

const dir = mkdtempSync(join(tmpdir(), "adsbook-backfill-"));
let written = 0;
let missing = 0;
console.log(`${bases.size} upload(s) from before ${DISPLAY_SIZED_SINCE} on ${host}${apply ? "" : " (dry run)"}`);
for (const base of bases.keys()) {
  const copies = [
    { key: `${base}-sm.webp`, variant: "display" as const, type: "image/webp" },
    { key: `${base}.jpg`, variant: "feed" as const, type: "image/jpeg" },
  ];
  const needed = [];
  for (const copy of copies) if (!(await stored(copy.key, copy.type))) needed.push(copy);
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
console.log(apply ? `${written} cop(ies) written` : `${missing} cop(ies) missing; re-run with --apply to write them`);
