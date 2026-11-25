import { defineConfig } from "@playwright/test";

/**
 * `npm run test:browser` (T-28): cookie and cache isolation in a real browser
 * against the local platform (`scripts/dev-local.ts`: workerd, local D1/KV/R2,
 * provider stand-ins). It reuses the last `astro build` (CI builds first) and
 * keeps its store in `.wrangler/browser-test-state`, wiped at every run, so a
 * developer's own `dev:local` store is never touched. Nothing here reaches
 * Cloudflare or a provider.
 */
export const PORT = Number(process.env.PLAYWRIGHT_PORT) || 8807;

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  globalSetup: "./tests/browser/global-setup.ts",
  use: {
    // Chrome resolves every *.localhost name to loopback by itself.
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node --experimental-strip-types scripts/dev-local.ts --reset --no-build --port=${PORT} --state=browser-test-state`,
    port: PORT,
    wait: { stdout: /Ready on/ },
    stdout: "pipe",
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
