import assert from "node:assert/strict";
import test from "node:test";
import { isStoreClosed, storeClosedMessage } from "./store-closed.ts";
import { subscriptionRefusalBody } from "../platform/billing.ts";

test("a not-live or demo store refusal is 'store closed'; a field error is not", () => {
  for (const code of ["SUBSCRIPTION_REQUIRED", "SUBSCRIPTION_EXPIRED", "DEMO_STORE"]) assert.equal(isStoreClosed({ code }), true, code);
  for (const payload of [{ code: "COD_NOT_AVAILABLE_FOR_REGION" }, { code: "STORE_NOT_READY" }, { error: "x" }, null, "x"]) assert.equal(isStoreClosed(payload), false);
});

test("the buyer reads one plain sentence: the server's buyer_message, a demo line, or the fallback", () => {
  const preview = subscriptionRefusalBody("preview");
  assert.equal(storeClosedMessage(preview), "Toko ini belum menerima pesanan. Silakan hubungi penjual atau coba lagi nanti.");
  assert.doesNotMatch(storeClosedMessage(preview), /Admin|langganan/i, "no seller-side wording for a buyer");
  assert.equal(storeClosedMessage({ code: "DEMO_STORE", error: "…" }), "Ini toko contoh adsbook.id: pemesanan tidak aktif.");
  assert.equal(storeClosedMessage({ code: "SUBSCRIPTION_EXPIRED" }), "Toko ini belum menerima pesanan. Silakan hubungi penjual atau coba lagi nanti.");
  // The seller and API clients still get the original wording in `error`.
  assert.match(preview.error, /Admin → Langganan/);
});
