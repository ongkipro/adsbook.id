import assert from "node:assert/strict";
import test from "node:test";
import { toSlug } from "./store-finder.ts";

test("UX-1: a store name becomes its subdomain label", () => {
  assert.equal(toSlug("  Toko Saya Jaya "), "toko-saya-jaya");
  assert.equal(toSlug("Café Ünïcode — 2026!"), "cafe-unicode-2026");
  assert.equal(toSlug("javascript:alert(1)"), "javascript-alert-1");
  assert.equal(toSlug("x".repeat(40)).length, 32);
});
