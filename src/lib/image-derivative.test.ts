import { test } from "node:test";
import assert from "node:assert/strict";
import { storefrontImageSrc } from "./image-derivative.ts";

test("an upload from before the 480 px rule is swapped for its 480 px twin", () => {
  assert.equal(
    storefrontImageSrc("/assets/uploads/2026-11-17/e52cf4c3-bd33.webp"),
    "/assets/uploads/2026-11-17/e52cf4c3-bd33-sm.webp",
  );
  assert.equal(storefrontImageSrc("/assets/uploads/2026-08-18/a-b-c.png"), "/assets/uploads/2026-08-18/a-b-c-sm.png");
});

test("an upload from 2026-11-18 on is already 480 px and is served as it is", () => {
  // No `-sm` twin exists for it: asking for one cost an R2 miss and an
  // uncached stand-in on every card.
  assert.equal(storefrontImageSrc("/assets/uploads/2026-11-18/a8de2b60.webp"), "/assets/uploads/2026-11-18/a8de2b60.webp");
  assert.equal(storefrontImageSrc("/assets/uploads/2027-01-02/ab.webp"), "/assets/uploads/2027-01-02/ab.webp");
});

test("anything that is not an upload is left exactly as it is", () => {
  assert.equal(storefrontImageSrc("/images/produk-contoh.webp"), "/images/produk-contoh.webp");
  assert.equal(storefrontImageSrc("https://cdn.example.com/x.webp"), "https://cdn.example.com/x.webp");
  assert.equal(storefrontImageSrc("/media/storefront/2026/a.webp"), "/media/storefront/2026/a.webp");
  assert.equal(storefrontImageSrc("/assets/uploads/2026-11-17/a.jpg?x=1"), "/assets/uploads/2026-11-17/a.jpg?x=1");
  assert.equal(storefrontImageSrc(""), "");
});

test("asking twice does not stack suffixes", () => {
  const once = storefrontImageSrc("/assets/uploads/2026-08-18/a.webp");
  assert.equal(storefrontImageSrc(once), once);
});

test("a listed static image is swapped for its card twin; an unlisted one is left alone", () => {
  const listed = new Set(["/images/landing/a/hero-product.webp"]);
  assert.equal(storefrontImageSrc("/images/landing/a/hero-product.webp", listed), "/images/landing/a/hero-product-sm.webp");
  assert.equal(storefrontImageSrc("/images/landing/b/hero-product.webp", listed), "/images/landing/b/hero-product.webp");
});
