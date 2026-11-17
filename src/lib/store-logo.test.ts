import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkLogoDimensions, checkLogoFile, fitInSquare, isAllowedLogoUrl, LOGO_EDGE, LOGO_MAX_INPUT_BYTES } from "./store-logo.ts";

test("a logo file is JPG, PNG or WebP up to 5 MB", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) assert.equal(checkLogoFile({ type, size: 1000 }).ok, true, type);
  for (const type of ["image/gif", "image/svg+xml", "image/avif", "application/pdf", ""]) assert.equal(checkLogoFile({ type, size: 1000 }).ok, false, type);
  assert.equal(checkLogoFile({ type: "image/png", size: LOGO_MAX_INPUT_BYTES }).ok, true);
  assert.equal(checkLogoFile({ type: "image/png", size: LOGO_MAX_INPUT_BYTES + 1 }).ok, false);
});

test("a logo is at least 256 px on its shortest edge", () => {
  assert.equal(checkLogoDimensions(256, 256).ok, true);
  assert.equal(checkLogoDimensions(1200, 300).ok, true);
  assert.equal(checkLogoDimensions(255, 1000).ok, false);
  assert.equal(checkLogoDimensions(0, 0).ok, false);
});

test("a logo is fitted into the 512 px square and centred, never cropped", () => {
  assert.deepEqual(fitInSquare(1024, 1024), { x: 0, y: 0, width: LOGO_EDGE, height: LOGO_EDGE });
  // A wide wordmark keeps its whole width; the square gains transparent bands above and below.
  assert.deepEqual(fitInSquare(1200, 300), { x: 0, y: 192, width: 512, height: 128 });
  // A tall mark keeps its whole height.
  assert.deepEqual(fitInSquare(300, 600), { x: 128, y: 0, width: 256, height: 512 });
  // Small sources are scaled up to the edge (the minimum edge keeps that sharp enough).
  assert.deepEqual(fitInSquare(256, 256), { x: 0, y: 0, width: 512, height: 512 });
});

test("a saved logo value is empty, a same-site path or https, never a script or protocol-relative URL", () => {
  for (const ok of ["", "/assets/uploads/2026-11-17/abc.webp", "/images/logo-toko.png", "https://cdn.toko.com/logo.webp"]) assert.equal(isAllowedLogoUrl(ok), true, ok);
  for (const bad of ["//evil.example/x.png", "javascript:alert(1)", "http://toko.com/logo.png", "data:image/png;base64,AAA", "/a b.png", '/a".png', "x".repeat(301)]) {
    assert.equal(isAllowedLogoUrl(bad), false, bad);
  }
});

test("the store settings page uploads the logo through the shared rules and the API refuses a bad value", () => {
  const page = readFileSync("src/pages/admin/settings/store.astro", "utf8");
  assert.match(page, /prepareStoreLogo/);
  assert.match(page, /\/api\/admin\/upload-r2/);
  assert.match(page, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(page, /body\.set\('purpose', 'logo'\)/);
  const api = readFileSync("src/pages/api/admin/settings.ts", "utf8");
  assert.match(api, /isAllowedLogoUrl\(/);
  const upload = readFileSync("src/pages/api/admin/upload-r2.ts", "utf8");
  assert.match(upload, /purpose === "logo" && \(file\.type !== "image\/webp" \|\| file\.size > LOGO_MAX_OUTPUT_BYTES\)/);
});
