import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorsOf, linkProblems, slugify } from "./docs-links.ts";

const files: Record<string, string> = {
  "/d/other.md": "# Other\n\n## Second part\n\n## Second part\n",
};
const read = (p: string) => files[p] ?? null;
const run = (src: string) => linkProblems("/d/a.md", src, read);

test("slugify follows GitHub rules", () => {
  assert.equal(slugify("The `foo` API: v2 (beta)!"), "the-foo-api-v2-beta");
  assert.equal(slugify("[Linked](x.md) *title*"), "linked-title");
});

test("anchors: duplicates, setext, explicit ids, code fences ignored", () => {
  const a = anchorsOf("# A\n\n## A\n\nSetext\n------\n\n<a id=\"Custom\"></a>\n\n```\n# not a heading\n```\n");
  for (const k of ["a", "a-1", "setext", "custom"]) assert.ok(a.has(k), k);
  assert.ok(!a.has("not-a-heading"));
});

test("undefined reference label fails; defined one resolves", () => {
  assert.equal(run("# T\n\n[x][nope]\n\n[other]: other.md\n").length, 1);
  assert.deepEqual(run("# T\n\n[x][ok] [ok][] [ok]\n\n[OK]: other.md\n"), []);
});

test("reference definition and shortcut targets are checked", () => {
  assert.match(run("# T\n\n[x][r]\n\n[r]: missing.md\n").join("\n"), /missing local link missing\.md/);
  assert.match(run("# T\n\n[r]\n\n[r]: <gone.md> \"title\"\n").join("\n"), /missing local link gone\.md/);
});

test("anchor that no heading provides fails, in-file and cross-file", () => {
  assert.match(run("# T\n\n[x](#nowhere)\n").join("\n"), /missing anchor #nowhere/);
  assert.match(run("# T\n\n[x](other.md#nowhere)\n").join("\n"), /missing anchor other\.md#nowhere/);
  assert.match(run("# T\n\n[x][r]\n\n[r]: #nowhere\n").join("\n"), /missing anchor #nowhere/);
});

test("valid links are preserved", () => {
  const src = "# Top Title\n\n[a](#top-title) [b](other.md#second-part) [c](other.md#second-part-1) [d](<other.md>) [e](other.md \"t\") [f](https://x.test/#y) [g](mailto:a@b.c)\n\n```md\n[no](#code) [x][undefined]\n```\n\nInline `[x][undefined]` is code.\n";
  assert.deepEqual(run(src), []);
});

test("GitHub line anchors are valid only inside the file", () => {
  files["/d/lines.md"] = "a\nb\nc\n";
  assert.deepEqual(run("# T\n\n[x](lines.md#L3) [y](lines.md#L1-L2)\n"), []);
  assert.match(run("# T\n\n[x](lines.md#L9)\n").join("\n"), /missing anchor lines\.md#L9/);
});

test("literal [a][b] tags pass in a document with no definitions", () => {
  assert.deepEqual(run("# T [data][read]\n\n[data][read]\n"), []);
});

test("heading keeps its code span text in the anchor", () => {
  assert.ok(anchorsOf("## Configure `TOKEN`\n").has("configure-token"));
  assert.deepEqual(run("# T\n\n## Configure `TOKEN`\n\n[x](#configure-token)\n"), []);
});

test("duplicate headings X, X, X-1 give x, x-1, x-1-1", () => {
  const a = anchorsOf("# X\n\n# X\n\n# X-1\n");
  assert.deepEqual([...a].sort(), ["x", "x-1", "x-1-1"]);
});
