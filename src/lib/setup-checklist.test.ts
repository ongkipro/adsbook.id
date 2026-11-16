import assert from "node:assert/strict";
import test from "node:test";
import { isStoreReady } from "../platform/readiness.ts";
import { buildSetupChecklist, type SetupFacts } from "./setup-checklist.ts";

// A fresh signup: the name comes from the form, COD and the default couriers start on.
const fresh: SetupFacts = {
  storeName: true,
  product: false,
  primaryWarehouse: false,
  mengantar: false,
  payment: true,
  enabledCouriers: 4,
  signals: false,
  customDomain: false,
};

test("a fresh signup owes product, primary warehouse and Mengantar; domain and signals are optional", () => {
  const steps = buildSetupChecklist(fresh);
  assert.deepEqual(steps.map((step) => step.id), ["store", "product", "warehouse", "mengantar", "couriers", "payment", "domain", "signals"]);
  assert.deepEqual(steps.filter((step) => step.required && !step.done).map((step) => step.id), ["product", "warehouse", "mengantar"]);
  assert.deepEqual(steps.filter((step) => !step.required).map((step) => step.id), ["domain", "signals"]);
  assert.ok(steps.every((step) => step.href.startsWith("/admin/")));
});

test("the required steps are exactly the ready predicate, fact by fact (UX-2 = PR-23)", () => {
  const done: SetupFacts = { ...fresh, product: true, primaryWarehouse: true, mengantar: true };
  assert.equal(isStoreReady(done), true);
  assert.ok(buildSetupChecklist(done).filter((step) => step.required).every((step) => step.done));
  const cases: Array<[Partial<SetupFacts>, string]> = [
    [{ storeName: false }, "store"],
    [{ product: false }, "product"],
    [{ primaryWarehouse: false }, "warehouse"],
    [{ mengantar: false }, "mengantar"],
    [{ enabledCouriers: 0 }, "couriers"],
    [{ payment: false }, "payment"],
  ];
  for (const [change, id] of cases) {
    const facts = { ...done, ...change };
    assert.equal(isStoreReady(facts), false, id);
    assert.deepEqual(buildSetupChecklist(facts).filter((step) => step.required && !step.done).map((step) => step.id), [id]);
  }
  // Optional steps never change readiness.
  assert.equal(isStoreReady({ ...done, signals: true }), true);
});
