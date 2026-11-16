import { spawnSync } from "node:child_process";
import { PORT } from "../../playwright.config.ts";
import { TENANTS } from "./tenants.ts";

/** Two ready stores, signed up through the platform's own signup and admin APIs. */
export default function globalSetup() {
  for (const tenant of TENANTS) {
    const seed = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/dev-seed.ts", `--platform=http://app.localhost:${PORT}`, `--slug=${tenant.slug}`, `--store-name=${tenant.name}`, "--orders=1"],
      { stdio: "inherit", timeout: 180_000 },
    );
    if (seed.status !== 0) throw new Error(`seeding ${tenant.slug} failed (exit ${seed.status})`);
  }
}
