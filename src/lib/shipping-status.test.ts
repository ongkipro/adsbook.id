import assert from "node:assert/strict";
import test from "node:test";
import { fulfillmentSteps, storeRelativeHref } from "./shipping-status.ts";

const base = { created_at: "2026-11-27T01:00:00Z" };
const row = (steps: ReturnType<typeof fulfillmentSteps>) => steps!.map((step) => `${step.label}:${step.state}`).join(" > ");

test("a pending order waits on confirmation: Dibuat done, Dikonfirmasi in progress", () => {
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "pending" })), "Dibuat:done > Dikonfirmasi:current > Diproses:upcoming > Dikirim:upcoming > Selesai:upcoming");
});

test("a lead CS converted is confirmed while still pending: never a not-done step with a time", () => {
  const steps = fulfillmentSteps({ ...base, shipping_status: "pending", confirmed_at: "2026-11-27T02:00:00Z" })!;
  assert.equal(row(steps), "Dibuat:done > Dikonfirmasi:done > Diproses:current > Dikirim:upcoming > Selesai:upcoming");
  for (const step of steps) if (step.at) assert.equal(step.state, "done", `${step.label} carries a time only when done`);
});

test("the journey advances one step per status, and a delivered order is complete", () => {
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "processing", confirmed_at: "2026-11-27T02:00:00Z" })), "Dibuat:done > Dikonfirmasi:done > Diproses:current > Dikirim:upcoming > Selesai:upcoming");
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "shipped" })), "Dibuat:done > Dikonfirmasi:done > Diproses:done > Dikirim:current > Selesai:upcoming");
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "delivered" })), "Dibuat:done > Dikonfirmasi:done > Diproses:done > Dikirim:done > Selesai:done");
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
  assert.equal(row(fulfillmentSteps({ ...base, shipping_status: "mystery" })), "Dibuat:done > Dikonfirmasi:current > Diproses:upcoming > Dikirim:upcoming > Selesai:upcoming");
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
