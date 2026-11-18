import assert from "node:assert/strict";
import test from "node:test";
import { storeLoginUrl, toSlug } from "./store-finder.ts";

const live = { protocol: "https:", port: "" };

test("UX-1: what a returning seller types becomes the store's /hello", () => {
  assert.deepEqual(storeLoginUrl("toko-saya", "adsbook.my.id", live), { url: "https://toko-saya.adsbook.my.id/hello" });
  assert.deepEqual(storeLoginUrl("  Toko Saya Jaya ", "adsbook.my.id", live), { url: "https://toko-saya-jaya.adsbook.my.id/hello" }, "a store name");
  assert.deepEqual(storeLoginUrl("https://Shop.Example.com/admin?x=1", "adsbook.my.id", live), { url: "https://shop.example.com/hello" }, "a pasted URL");
  assert.deepEqual(storeLoginUrl("toko.example.com#a", "adsbook.my.id", live), { url: "https://toko.example.com/hello" });
  // Local development keeps the page's own scheme and port on *.localhost.
  assert.deepEqual(storeLoginUrl("toko", "localhost", { protocol: "http:", port: "8807" }), { url: "http://toko.localhost:8807/hello" });
  // A live store is always https on its own default port, whatever page the finder runs on.
  assert.deepEqual(storeLoginUrl("toko", "adsbook.my.id", { protocol: "http:", port: "8080" }), { url: "https://toko.adsbook.my.id/hello" });
});

test("UX-1: nothing that is not a host leaves the page", () => {
  for (const raw of ["", "   ", "!!!", ".evil.com", "evil.com.", "a..b.com", "a b.com", "evil.com@x.com", "javascript:x.com"]) {
    assert.ok("error" in storeLoginUrl(raw, "adsbook.my.id", live), JSON.stringify(raw));
  }
  // A scheme with no dot is only ever a slug: the URL stays on the seller zone.
  assert.deepEqual(storeLoginUrl("javascript:alert(1)", "adsbook.my.id", live), { url: "https://javascript-alert-1.adsbook.my.id/hello" });
  assert.equal(toSlug("Café Ünïcode — 2026!"), "cafe-unicode-2026");
  assert.equal(toSlug("x".repeat(40)).length, 32);
});
