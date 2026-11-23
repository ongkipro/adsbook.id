import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveFormMode, PHYSICAL_FORM_MODES, physicalFormMode, productKind } from "./checkout-forms.ts";

test("a physical product picks one of three forms; a digital product has one", () => {
  assert.deepEqual(PHYSICAL_FORM_MODES.map((mode) => mode.value), ["hybrid", "middle", "full"]);
  assert.deepEqual(PHYSICAL_FORM_MODES.map((mode) => mode.path), ["/hybrid-form", "/middle-form", "/full-form"]);
  assert.equal(effectiveFormMode("physical", "full"), "full");
  assert.equal(effectiveFormMode("physical", "middle"), "middle");
  // Whatever was picked before the product turned digital, its links carry the one mode every route accepts.
  for (const picked of ["hybrid", "middle", "full"] as const) assert.equal(effectiveFormMode("digital", picked), "hybrid");
});

test("an unknown type is physical and an unknown mode is hybrid", () => {
  assert.equal(productKind("digital"), "digital");
  assert.equal(productKind("physical"), "physical");
  assert.equal(productKind(null), "physical");
  assert.equal(productKind(undefined), "physical");
  assert.equal(physicalFormMode("full").value, "full");
  assert.equal(physicalFormMode("wide").value, "hybrid");
  assert.equal(physicalFormMode(undefined).value, "hybrid");
});
