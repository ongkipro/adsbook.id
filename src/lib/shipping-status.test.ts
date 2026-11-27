import assert from "node:assert/strict";
import test from "node:test";
import { fulfillmentSteps, storeRelativeHref } from "./shipping-status.ts";

const base = { created_at: "2026-11-27T01:00:00Z" };
const row = (steps: ReturnType<typeof fulfillmentSteps>) => steps!.map((step) => `${step.label}:${step.state}`).join(" > ");

test("a pending order waits on confirmation: Dibuat done, Dikonfirmasi in progress", () => {
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "pending" })), "Dibuat:done > Dikonfirmasi:current > Diproses:upcoming > Dalam pengiriman:upcoming > Terkirim:upcoming");
});

test("a lead CS converted is confirmed while still pending: never a not-done step with a time", () => {
  const steps = fulfillmentSteps({ ...base, shipping_status: "pending", confirmed_at: "2026-11-27T02:00:00Z" })!;
  assert.equal(row(steps), "Dibuat:done > Dikonfirmasi:done > Diproses:current > Dalam pengiriman:upcoming > Terkirim:upcoming");
  for (const step of steps) if (step.at) assert.equal(step.state, "done", `${step.label} carries a time only when done`);
});

test("the journey advances one step per status, and a delivered order is complete", () => {
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "processing", confirmed_at: "2026-11-27T02:00:00Z" })), "Dibuat:done > Dikonfirmasi:done > Diproses:current > Dalam pengiriman:upcoming > Terkirim:upcoming");
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "shipped" })), "Dibuat:done > Dikonfirmasi:done > Diproses:done > Dalam pengiriman:current > Terkirim:upcoming");
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "delivered" })), "Dibuat:done > Dikonfirmasi:done > Diproses:done > Dalam pengiriman:done > Terkirim:done");
});

test("a return stops after Diproses, a cancel where the order stood; nothing after them is shown", () => {
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "returned" })), "Dibuat:done > Dikonfirmasi:done > Diproses:done > Retur (RTS):stopped");
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "cancelled" })), "Dibuat:done > Dibatalkan:stopped");
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "cancelled", confirmed_at: "2026-11-27T02:00:00Z" })), "Dibuat:done > Dikonfirmasi:done > Dibatalkan:stopped");
});

test("a time is shown only for the step that recorded it: created and confirmed, never the courier's event", () => {
  const steps = fulfillmentSteps({ ...base, shipping_status: "shipped", confirmed_at: "2026-11-27T02:00:00Z", provider_status_at: "2026-11-27T05:00:00Z" } as never)!;
  assert.deepEqual(steps.map((step) => step.at), ["2026-11-27T01:00:00Z", "2026-11-27T02:00:00Z", null, null, null]);
});

test("an unknown status reads as a fresh order, never further along", () => {
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "mystery" })), "Dibuat:done > Dikonfirmasi:current > Diproses:upcoming > Dalam pengiriman:upcoming > Terkirim:upcoming");
});

test("a digital order has no shipping journey", () => {
  assert.equal(fulfillmentSteps({ ...base, shipping_status: "pending", fulfillment_type: "digital" }), null);
});

test("a landing path becomes a link only when it is a path on this store", () => {
  assert.equal(storeRelativeHref("/promo-a?utm_source=fb"), "/promo-a?utm_source=fb");
  for (const unsafe of ["javascript:alert(1)", "https://evil.example/", "//evil.example/x", "/\\evil.example", "promo-a", "", null, "/a b", "/a\nb"]) {
    assert.equal(storeRelativeHref(unsafe), null, String(unsafe));
  }
});

test("Mengantar's categories read in a seller's words, with the ones needing a look marked", async () => {
  const { mengantarStatusView, MENGANTAR_STATUS_LABELS } = await import("./shipping-status.ts");
  assert.deepEqual(mengantarStatusView("ON DELIVERY"), { category: "ON DELIVERY", label: "Dalam pengiriman", tone: "moving" });
  assert.deepEqual(mengantarStatusView("  pending   pickup "), { category: "PENDING PICKUP", label: "Menunggu pickup", tone: "idle" });
  assert.equal(mengantarStatusView("active")?.label, "Menunggu update kurir", "GET /order's lower-case `active`");
  for (const needsLook of ["UNDELIVERED", "PICKUP FAILED", "CANCELED", "CANCELLED", "ERROR"]) {
    assert.equal(mengantarStatusView(needsLook)?.tone, "attention", needsLook);
  }
  assert.equal(mengantarStatusView("DELIVERED")?.tone, "done");
  assert.equal(mengantarStatusView("RTS")?.tone, "returned");
  assert.deepEqual(mengantarStatusView("HELD AT HUB"), { category: "HELD AT HUB", label: "HELD AT HUB", tone: "idle" }, "an unknown courier value shows as received");
  assert.equal(mengantarStatusView(null), null);
  assert.equal(mengantarStatusView("  "), null);
  for (const key of Object.keys(MENGANTAR_STATUS_LABELS)) assert.equal(key, key.trim().replace(/\s+/g, " ").toUpperCase(), `${key} is stored normalised`);
});

test("the Mengantar block never says 'no update' beside an update, and never shows a word twice", async () => {
  const { mengantarBlock } = await import("./shipping-status.ts");
  // Synced before categories were kept: the courier line is the headline.
  const legacy = mengantarBlock({ category: null, text: "Paket telah diterima", orderStatusLabel: "Terkirim" });
  assert.equal(legacy.headline, "Paket telah diterima");
  assert.equal(legacy.view, null);
  assert.equal(mengantarBlock({ category: null, text: null, orderStatusLabel: "Diproses Mengantar" }).headline, "Belum ada update dari kurir");

  // A label repeating the order's own badge is left out; a state needing a look always shows.
  assert.equal(mengantarBlock({ category: "ON DELIVERY", text: null, orderStatusLabel: "Dalam pengiriman" }).showLabel, false);
  assert.equal(mengantarBlock({ category: "PENDING PICKUP", text: null, orderStatusLabel: "Diproses Mengantar" }).showLabel, true);
  assert.equal(mengantarBlock({ category: "UNDELIVERED", text: null, orderStatusLabel: "Gagal kirim" }).showLabel, true);

  // An unknown category is not repeated as its own reference.
  const unknown = mengantarBlock({ category: "HELD AT HUB", text: null, orderStatusLabel: "Dalam pengiriman" });
  assert.equal(unknown.headline, "HELD AT HUB");
  assert.equal(unknown.reference, null);
  assert.equal(mengantarBlock({ category: "PENDING PICKUP", text: null, orderStatusLabel: "x" }).reference, "PENDING PICKUP");

  // What the webhook writes is hidden; a courier line that merely contains the word is kept.
  for (const written of ["UNDELIVERED", "Perlu perhatian kurir (UNDELIVERED)"]) {
    assert.equal(mengantarBlock({ category: "UNDELIVERED", text: written, orderStatusLabel: "x" }).courierLine, null, written);
  }
  assert.equal(mengantarBlock({ category: "CANCELED", text: "Pembatalan dari kurir — perlu cek operator (CANCELED)", orderStatusLabel: "x" }).courierLine, null);
  assert.equal(mengantarBlock({ category: "DELIVERED", text: "DELIVERED TO [BUDI | RUMAH]", orderStatusLabel: "Terkirim" }).courierLine, "DELIVERED TO [BUDI | RUMAH]");
  assert.equal(mengantarBlock({ category: "RTS", text: "Paket diretur, REPORTS dikirim", orderStatusLabel: "x" }).courierLine, "Paket diretur, REPORTS dikirim");
});
