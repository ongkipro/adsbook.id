import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAutoLarisOrderIdentity, resolveCredentialUpdate } from "./provider-config.ts";

test("an empty credential submission keeps the stored value", () => {
  assert.deepEqual(resolveCredentialUpdate(""), { clear: false, value: "" });
  assert.deepEqual(resolveCredentialUpdate("   "), { clear: false, value: "" });
  assert.deepEqual(resolveCredentialUpdate(undefined), {
    clear: false,
    value: "",
  });
});

test("an explicit null clears the credential so the server fallback applies", () => {
  assert.deepEqual(resolveCredentialUpdate(null), { clear: true, value: "" });
});

test("a submitted credential is trimmed, and a non-string never clears", () => {
  assert.deepEqual(resolveCredentialUpdate("  API-123  "), {
    clear: false,
    value: "API-123",
  });
  assert.deepEqual(resolveCredentialUpdate(42), { clear: false, value: "" });
  assert.deepEqual(resolveCredentialUpdate({}), { clear: false, value: "" });
});

test("AutoLaris is ready only with key, a valid area pair and a warehouse address", async () => {
  const { autoLarisOrderRailGap } = await import("./provider-config.ts");
  const ready = { apiKey: "k", originId: "3517100", destinationId: "3518010", warehouseAddress: "Jl. Kapitan 1" };
  assert.equal(autoLarisOrderRailGap(ready), null);
  assert.match(autoLarisOrderRailGap({ ...ready, apiKey: " " }) ?? "", /belum dikonfigurasi/);
  for (const bad of ["", "abc", "0", "-5", "35.17"]) {
    assert.match(autoLarisOrderRailGap({ ...ready, originId: bad }) ?? "", /origin\/destination/, bad);
    assert.match(autoLarisOrderRailGap({ ...ready, destinationId: bad }) ?? "", /origin\/destination/, bad);
  }
  assert.match(autoLarisOrderRailGap({ ...ready, warehouseAddress: null }) ?? "", /gudang/);
  assert.match(autoLarisOrderRailGap({ ...ready, warehouseAddress: "  " }) ?? "", /gudang/);
});

const STORED = { originId: "3517100", destinationId: "3518010", shipperEmail: "gudang@toko.test" };

test("AutoLaris order identity: a field left out keeps its stored value; empty clears (T-45 review)", () => {
  // A save that only rotates a Mengantar key must not close the QRIS/VA rail.
  assert.deepEqual(parseAutoLarisOrderIdentity({}, STORED), {
    ok: true, originId: "3517100", destinationId: "3518010", shipperEmail: "gudang@toko.test",
  });
  assert.deepEqual(parseAutoLarisOrderIdentity({ originId: "", destinationId: "", shipperEmail: "" }, STORED), {
    ok: true, originId: null, destinationId: null, shipperEmail: null,
  });
  assert.deepEqual(parseAutoLarisOrderIdentity({ originId: " 1 ", destinationId: "2" }, STORED), {
    ok: true, originId: "1", destinationId: "2", shipperEmail: "gudang@toko.test",
  });
});

test("AutoLaris order identity refuses a half pair, a non-id, a bad email and a non-string", () => {
  const none = { originId: "", destinationId: "", shipperEmail: "" };
  for (const input of [
    { originId: "1" },
    { originId: "1", destinationId: "0" },
    { originId: "1", destinationId: "x2" },
    { originId: "1", destinationId: "2", shipperEmail: "not-an-email" },
    { originId: 1, destinationId: 2 },
  ]) {
    assert.equal(parseAutoLarisOrderIdentity(input as never, none).ok, false, JSON.stringify(input));
  }
});
