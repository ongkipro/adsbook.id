import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import {
  checkStoredVariant,
  checkUploadSource,
  fitWidth,
  IMAGE_VARIANTS,
  jpegDimensions,
  MAX_UPLOAD_BYTES,
  webpDimensions,
} from "./image-rules.ts";

test("every upload is JPG, PNG or WebP up to 2 MB", () => {
  assert.equal(MAX_UPLOAD_BYTES, 2 * 1024 * 1024);
  for (const type of ["image/jpeg", "image/png", "image/webp"]) assert.equal(checkUploadSource({ type, size: 1000 }).ok, true, type);
  for (const type of ["image/gif", "image/avif", "image/svg+xml", "application/pdf"]) assert.equal(checkUploadSource({ type, size: 1000 }).ok, false, type);
  assert.equal(checkUploadSource({ type: "image/png", size: MAX_UPLOAD_BYTES }).ok, true);
  assert.equal(checkUploadSource({ type: "image/png", size: MAX_UPLOAD_BYTES + 1 }).ok, false);
  assert.equal(checkUploadSource({ type: "image/png", size: 0 }).ok, false);
});

test("the store copy is at most 480 px wide with the height following the photo; the catalog copy at most 1024", () => {
  assert.equal(IMAGE_VARIANTS.display.maxWidth, 480);
  assert.equal(IMAGE_VARIANTS.display.type, "image/webp");
  assert.equal(IMAGE_VARIANTS.feed.maxWidth, 1024);
  assert.equal(IMAGE_VARIANTS.feed.type, "image/jpeg", "Meta catalogs take JPEG or PNG only");
  assert.deepEqual(fitWidth(2000, 2000, 480), { width: 480, height: 480 });
  assert.deepEqual(fitWidth(1600, 2400, 480), { width: 480, height: 720 }, "portrait: height auto");
  assert.deepEqual(fitWidth(1920, 1080, 480), { width: 480, height: 270 }, "landscape: height auto");
  assert.deepEqual(fitWidth(300, 500, 480), { width: 300, height: 500 }, "never upscaled");
  assert.deepEqual(fitWidth(3000, 3000, 1024), { width: 1024, height: 1024 });
});

test("the server accepts only the pipeline's output for each variant", () => {
  assert.equal(checkStoredVariant("display", { type: "image/webp", size: 120_000 }).ok, true);
  assert.equal(checkStoredVariant("display", { type: "image/png", size: 120_000 }).ok, false);
  assert.equal(checkStoredVariant("display", { type: "image/webp", size: IMAGE_VARIANTS.display.maxBytes + 1 }).ok, false);
  assert.equal(checkStoredVariant("feed", { type: "image/jpeg", size: 400_000 }).ok, true);
  assert.equal(checkStoredVariant("feed", { type: "image/webp", size: 400_000 }).ok, false);
});

test("WebP and JPEG dimensions are read from the bytes, whatever encoder made them", async () => {
  const lossy = await sharp({ create: { width: 480, height: 731, channels: 3, background: "#2563eb" } }).webp({ quality: 80 }).toBuffer();
  const lossless = await sharp({ create: { width: 300, height: 200, channels: 4, background: "#ffffff00" } }).webp({ lossless: true }).toBuffer();
  const alpha = await sharp({ create: { width: 512, height: 512, channels: 4, background: "#ffffff00" } }).webp({ quality: 80 }).toBuffer();
  assert.deepEqual(webpDimensions(new Uint8Array(lossy)), { width: 480, height: 731 });
  assert.deepEqual(webpDimensions(new Uint8Array(lossless)), { width: 300, height: 200 });
  assert.deepEqual(webpDimensions(new Uint8Array(alpha)), { width: 512, height: 512 });
  const jpeg = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#ffffff" } }).jpeg({ quality: 80 }).toBuffer();
  const progressive = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#000000" } }).jpeg({ progressive: true }).toBuffer();
  assert.deepEqual(jpegDimensions(new Uint8Array(jpeg)), { width: 1024, height: 1536 });
  assert.deepEqual(jpegDimensions(new Uint8Array(progressive)), { width: 640, height: 480 });
  assert.equal(webpDimensions(new Uint8Array(jpeg)), null);
  assert.equal(jpegDimensions(new Uint8Array(lossy)), null);
});

test("every admin image path runs through the one pipeline", () => {
  for (const file of ["src/components/admin/ProductForm.tsx", "src/components/admin/LandingPageEditor.tsx", "src/components/admin/ContentWorkbench.tsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /processImageUpload\(/, `${file} processes before upload`);
    assert.doesNotMatch(source, /image\/gif|image\/avif/, `${file} offers only JPG, PNG, WebP`);
  }
  assert.match(readFileSync("src/components/admin/ProductForm.tsx", "utf8"), /processImageUpload\(file, \{ feed: true \}\)/, "product photos make the catalog copy");
  const route = readFileSync("src/pages/api/admin/upload-r2.ts", "utf8");
  assert.match(route, /webpDimensions\(/);
  assert.match(route, /dimensions\.width > IMAGE_VARIANTS\[variant\]\.maxWidth/);
  const media = readFileSync("src/pages/api/admin/media.ts", "utf8");
  assert.match(media, /dimensions\.width > IMAGE_VARIANTS\.display\.maxWidth/);
});

test("a catalog copy too narrow for Meta and Google is centred on a white square, never refused or upscaled", async () => {
  const { feedLayout, FEED_MIN_WIDTH } = await import("./image-rules.ts");
  // demo's lem-serbaguna photo: a 332 x 1280 portrait.
  assert.deepEqual(feedLayout(332, 1280), { canvas: { width: 1024, height: 1024 }, draw: { x: 379, y: 0, width: 266, height: 1024 } });
  // Large enough already: drawn as fitWidth sizes it, no padding.
  assert.deepEqual(feedLayout(2000, 1500), { canvas: { width: 1024, height: 768 }, draw: { x: 0, y: 0, width: 1024, height: 768 } });
  assert.deepEqual(feedLayout(600, 600), { canvas: { width: 600, height: 600 }, draw: { x: 0, y: 0, width: 600, height: 600 } });
  // Small source: a 500 px square around it, the photo kept at its own size.
  assert.deepEqual(feedLayout(400, 300), { canvas: { width: 500, height: 500 }, draw: { x: 50, y: 100, width: 400, height: 300 } });
  // Wide panorama: the short side would be 256, so it gets a square too.
  const wide = feedLayout(4000, 1000);
  assert.deepEqual(wide.canvas, { width: 1024, height: 1024 });
  assert.equal(wide.draw.width, 1024);
  for (const [w, h] of [[332, 1280], [400, 300], [4000, 1000], [120, 90], [3000, 3000]]) {
    const { canvas, draw } = feedLayout(w, h);
    assert.ok(Math.min(canvas.width, canvas.height) >= FEED_MIN_WIDTH, `${w}x${h} clears the catalog minimum`);
    assert.ok(draw.width <= w && draw.height <= h, `${w}x${h} is never upscaled`);
    assert.ok(draw.x + draw.width <= canvas.width && draw.y + draw.height <= canvas.height, `${w}x${h} fits its canvas`);
  }
});

test("the seed and backfill encoder pads a narrow photo the same way", async () => {
  const { encode } = await import("../../scripts/prepare-image.ts");
  const tall = await sharp({ create: { width: 332, height: 1280, channels: 3, background: "#cc3333" } }).png().toBuffer();
  const out = await sharp(await encode(tall, "feed")).metadata();
  assert.deepEqual([out.format, out.width, out.height], ["jpeg", 1024, 1024]);
  const display = await sharp(await encode(tall, "display")).metadata();
  assert.deepEqual([display.format, display.width, display.height], ["webp", 332, 1280], "the store copy is never padded");
});
