import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../pages/api/admin/upload-r2.ts", import.meta.url), "utf8");
const form = readFileSync(new URL("../components/admin/ProductForm.tsx", import.meta.url), "utf8");

test("an upload spends the plan cap once, before storing; the catalog copy spends its own allowance (T-37)", () => {
  const spends = route.match(/checkPlanCap\(/g) ?? [];
  assert.equal(spends.length, 1, "one atomic spend, no separate peek");
  assert.ok(route.indexOf("checkPlanCap(") < route.indexOf("bucket.put("), "spent before the object is stored");
  assert.match(route, /isFeed \? "media-derivative" : "media"/);
});

test("the product form reports a catalog copy that failed instead of swallowing it", () => {
  assert.match(form, /feedStored/);
  assert.doesNotMatch(form, /deliberately ignored/);
});

test("the asset route does not pin a stand-in body for a year", () => {
  const assets = readFileSync(new URL("../pages/assets/[...key].ts", import.meta.url), "utf8");
  assert.match(assets, /standIn \? 'public, max-age=600'/);
  assert.equal((assets.match(/standIn = Boolean\(object\)/g) ?? []).length, 2, "both fallbacks mark the stand-in");
});

test("the landing editor reads the upload route's own shape", () => {
  const editor = readFileSync(new URL("../components/admin/LandingPageEditor.tsx", import.meta.url), "utf8");
  // upload-r2 answers `jsonOk({ url, fileName })`, i.e. `{ success, url, fileName }`.
  assert.match(route, /jsonOk\(\{\s*url:/);
  assert.doesNotMatch(editor, /payload\.data\.url/);
  assert.match(readFileSync(new URL("./client-image.ts", import.meta.url), "utf8"), /url: String\(payload\.url\)/);
});
