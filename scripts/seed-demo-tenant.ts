/**
 * `npm run seed:demo` — the one display-only demo store (T-41, PR-26) on a
 * running `npm run dev:local` platform.
 *
 * 1. Signs up `demo` through the normal signup path and adds the sample
 *    catalogue (`dev-seed.ts --catalogue-only`: no provider keys, no
 *    warehouse, no orders).
 * 2. Flags it `is_demo` in the local control plane. From then on the store
 *    browses without the readiness gate, shows the "toko contoh" banner, and
 *    refuses every provider route and every write (src/platform/demo.ts).
 *
 * Idempotent: an existing `demo` is not signed up again, existing products
 * are left alone, and the flag is set once. Local only: it refuses --remote
 * and any non-local platform URL (production seeding belongs to T-31).
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith("--remote"))) {
  console.error("[seed:demo] refusing --remote: this script only seeds the local dev:local platform.");
  process.exit(1);
}
const platform = args.find((arg) => arg.startsWith("--platform="))?.split("=").slice(1).join("=") || "http://app.localhost:8787";
const root = new URL("../", import.meta.url).pathname;

const seed = spawnSync(process.execPath, ["--experimental-strip-types", `${root}scripts/dev-seed.ts`, `--platform=${platform}`, "--slug=demo", "--catalogue-only"], {
  stdio: "inherit",
});
if (seed.status !== 0) process.exit(seed.status ?? 1);

const flag = spawnSync(
  "npx",
  [
    "--no-install", "wrangler", "d1", "execute", "PLATFORM_DB", "--local",
    "-c", `${root}dist/server/wrangler.dev-local.json`,
    "--persist-to", `${root}.wrangler/dev-local-state`,
    "--command", "UPDATE tenants SET is_demo = 1, cache_version = cache_version + 1 WHERE slug = 'demo' AND is_demo = 0",
  ],
  { stdio: ["ignore", "pipe", "inherit"], cwd: root },
);
if (flag.status !== 0) {
  console.error("[seed:demo] could not flag the demo tenant in the local control plane.");
  process.exit(flag.status ?? 1);
}
console.log("[seed:demo] demo is the display-only demo store (is_demo = 1). Host caches may take up to their TTL to pick the flag up.");
