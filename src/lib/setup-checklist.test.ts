import assert from "node:assert/strict";
import test from "node:test";
import { isStoreReady, readinessTrack } from "../platform/readiness.ts";
import { buildSetupChecklist, type SetupFacts } from "./setup-checklist.ts";

// A fresh signup: the name comes from the form, COD and the default couriers start on.
const fresh: SetupFacts = {
  catalogMode: "physical",
  physicalCatalog: false,
  digitalProduct: false,
  prepaid: false,
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

test("DIGITAL-PRODUCTS-SPEC §3: a digital store owes name, a digital product with its link, and a prepaid rail — nothing that ships", () => {
  const digital: SetupFacts = { ...fresh, catalogMode: "digital", payment: true, enabledCouriers: 0 };
  assert.deepEqual(buildSetupChecklist(digital).map((step) => step.id), ["store", "product", "payment", "domain", "signals"]);
  assert.deepEqual(buildSetupChecklist(digital).filter((step) => step.required && !step.done).map((step) => step.id), ["product", "payment"]);
  assert.equal(isStoreReady(digital), false);
  const done = { ...digital, digitalProduct: true, prepaid: true };
  assert.equal(isStoreReady(done), true, "no warehouse, no Mengantar key, no courier");
  for (const [change, id] of [[{ storeName: false }, "store"], [{ digitalProduct: false }, "product"], [{ prepaid: false }, "payment"]] as const) {
    const facts = { ...done, ...change };
    assert.equal(isStoreReady(facts), false, id);
    assert.deepEqual(buildSetupChecklist(facts).filter((step) => step.required && !step.done).map((step) => step.id), [id]);
  }
  // COD alone is not a prepaid rail: a digital order is never COD.
  assert.equal(isStoreReady({ ...done, prepaid: false, payment: true }), false);
});

test("review finding 1: a hybrid store is ready on either track; a physical product never closes a store selling digital", () => {
  const hybrid: SetupFacts = { ...fresh, catalogMode: "hybrid", digitalProduct: true, prepaid: true };
  assert.equal(readinessTrack(hybrid), "digital");
  assert.equal(isStoreReady(hybrid), true, "a hybrid creator opens before any warehouse");
  const withPhysical = { ...hybrid, physicalCatalog: true, product: true };
  assert.equal(isStoreReady(withPhysical), true, "adding a physical product keeps the digital store open");
  assert.equal(readinessTrack(withPhysical), "digital");
  const steps = buildSetupChecklist(withPhysical);
  assert.ok(steps.filter((step) => step.required).every((step) => step.done), "the checklist says ready exactly when the store is");
  assert.deepEqual(steps.filter((step) => !step.required && !step.done).map((step) => step.id), ["warehouse", "mengantar", "domain", "signals"], "what the physical products still owe, as optional steps");
  // No digital track: the physical one decides, with its steps required.
  const physicalOnly: SetupFacts = { ...fresh, catalogMode: "hybrid", physicalCatalog: true, product: true };
  assert.equal(readinessTrack(physicalOnly), "physical");
  assert.equal(isStoreReady(physicalOnly), false);
  assert.equal(isStoreReady({ ...physicalOnly, primaryWarehouse: true, mengantar: true }), true);
  // An existing store migrated to 'hybrid' keeps exactly today's predicate.
  const existing: SetupFacts = { ...fresh, catalogMode: "hybrid", physicalCatalog: true, product: true, primaryWarehouse: true, mengantar: true };
  assert.equal(isStoreReady(existing), true);
  assert.equal(isStoreReady({ ...existing, mengantar: false }), false);
  assert.equal(readinessTrack({ ...fresh, catalogMode: "physical", digitalProduct: true, prepaid: true }), "physical", "a physical store never takes the digital predicate");
  assert.equal(isStoreReady({ ...fresh, catalogMode: "physical", digitalProduct: true, prepaid: true }), false);
});

