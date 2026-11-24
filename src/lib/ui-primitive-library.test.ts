// One headless library for the whole UI (owner, 2026-11-24: "1 kesatuan biar
// ringan … base nova shadcn"). components.json is base-nova, so every
// component imports @base-ui/react. Radix was removed after the four
// convergence commits; this fails the moment it, or another primitive
// library, comes back through a pasted component or a hand install.
//
// cmdk (the admin command palette) is the one allowed exception: the
// base-nova registry's own Command is built on it, and it bundles a few
// @radix-ui internals of its own. No component in this repo imports them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = /from\s+["'](radix-ui|@radix-ui\/[^"']+|react-aria-components|@headlessui\/react|next-themes)["']/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|astro)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

test("components and pages import one primitive library: Base UI", () => {
  const offenders = ["src/components", "src/pages", "src/layouts", "src/lib"].flatMap(files).filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});

test("package.json declares no second primitive library", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(deps.includes("@base-ui/react"), "Base UI is the declared library");
  assert.deepEqual(deps.filter((name) => /^(radix-ui|@radix-ui\/|react-aria-components$|@headlessui\/|next-themes$)/.test(name)), []);
  assert.equal(JSON.parse(readFileSync("components.json", "utf8")).style, "base-nova");
});
