import assert from "node:assert/strict";
import test from "node:test";
import { digitalAccessOpen, digitalAccessStage } from "./digital-access.ts";

test("the admin list's access stage says open exactly when the buyer's link opens", () => {
  const cases: Array<[payment: string, shipping: string, restored: string | null, stage: "void" | "open" | "unpaid"]> = [
    ["pending", "pending", null, "unpaid"],
    ["unpaid", "pending", null, "unpaid"],
    ["paid", "delivered", null, "open"],
    // Paid, the delivered move not made yet: the buyer's link already works.
    ["settled", "pending", null, "open"],
    // A paid order an operator set to Retur (RTS) is void: the buyer's link is closed.
    ["paid", "returned", null, "void"],
    ["paid", "cancelled", null, "void"],
    ["refunded", "delivered", null, "void"],
    ["failed", "pending", null, "void"],
    ["pending", "pending", "2026-11-28T00:00:00.000Z", "void"],
  ];
  for (const [payment_status, shipping_status, stock_restored_at, stage] of cases) {
    const order = { payment_status, shipping_status, stock_restored_at };
    assert.equal(digitalAccessStage(order), stage, `${payment_status}/${shipping_status}/${stock_restored_at}`);
    assert.equal(digitalAccessStage(order) === "open", digitalAccessOpen({ ...order, fulfillment_type: "digital" }));
  }
});
