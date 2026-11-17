import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStorefrontMediaKey,
  MAX_STOREFRONT_MEDIA_BYTES,
  validateStorefrontMedia,
} from "./storefront-media.ts";

test("storefront media keys remain tenant-relative and path safe", () => {
  const file = { name: "Hero ../ Merchant.webp", type: "image/webp", size: 1024 };
  assert.deepEqual(validateStorefrontMedia(file), {
    extension: "webp",
    base: "hero-merchant",
  });
  assert.equal(
    buildStorefrontMediaKey(file, "fixed-id", new Date("2026-08-10T00:00:00Z")),
    "content/2026-08/fixed-id-hero-merchant.webp",
  );
});

test("storefront media rejects active content and oversized files", () => {
  assert.throws(
    () => validateStorefrontMedia({ name: "image.svg", type: "image/svg+xml", size: 100 }),
    /Format gambar/,
  );
  assert.throws(
    () => validateStorefrontMedia({ name: "image.webp", type: "image/webp", size: MAX_STOREFRONT_MEDIA_BYTES + 1 }),
    /maksimal 2 MB/,
  );
  // Only the admin pipeline's WebP is stored: a raw PNG or JPEG is refused.
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/avif"]) {
    assert.throws(() => validateStorefrontMedia({ name: "x", type, size: 100 }), /Format gambar/, type);
  }
});
