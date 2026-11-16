/**
 * `npm run dev:local` — a complete store on this machine, one command.
 *
 *   build → local Mengantar/AutoLaris stand-ins → `wrangler dev --local`
 *
 * The Worker runs exactly as it would on Cloudflare (workerd, D1/KV/R2 in
 * `.wrangler/dev-local-state`), applies its own migrations on the first
 * request, and redirects to /install. Provider calls go to
 * `scripts/dev-providers.ts` on 127.0.0.1, so checkout, dispatch and QRIS/VA
 * all work without an account anywhere.
 *
 *   --reset      wipe the local store first (only its state directory)
 *   --state=<name>  keep the store in .wrangler/<name> instead of
 *                dev-local-state (the browser suite uses its own, so a test
 *                run never wipes a developer's local store)
 *   --no-build   reuse the last `astro build`
 *   --port=8787  Worker port (providers use port + 1)
 *   --platform-pixel  give the platform pages a test Pixel id and send the
 *                server CompleteRegistration to the local Graph stand-in
 *                (GET <providers>/__dev/meta/events). Off by default: with an
 *                id set, the browser loads Meta's script for real.
 *   --ip=<addr>  listen on this address instead of localhost — e.g. the
 *                machine's Tailscale IP, to open the store from another
 *                device on the tailnet. Providers stay on 127.0.0.1.
 *
 * Nothing here is read by a deploy: the env file lives under `.wrangler/`
 * (ignored) and is empty on purpose, so a developer's own `.env` or
 * `.dev.vars` never reaches the local Worker. There is no installer or
 * INSTALL_TOKEN (T-21); a tenant exists once PLATFORM_DB names it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startDevProviders } from "./dev-providers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const portArg = process.argv.slice(2).find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.split("=")[1]) || 8787;
const host = process.argv.slice(2).find((arg) => arg.startsWith("--ip="))?.split("=")[1] || "";
const providerPort = port + 1;
const stateName = process.argv.slice(2).find((arg) => arg.startsWith("--state="))?.split("=")[1] || "dev-local-state";
if (!/^[a-z0-9-]+$/.test(stateName)) {
  console.error("[dev:local] --state takes a plain name (a-z, 0-9, -): it becomes a folder under .wrangler/.");
  process.exit(1);
}
const stateDir = `${root}.wrangler/${stateName}`;
const envFile = `${root}.wrangler/dev-local.env`;

// A second run while the first is still up used to die inside wrangler with
// "Address already in use" — after --reset had already wiped the state the
// running store was using. Refuse before touching anything.
async function portInUse(candidate: number) {
  const { createConnection } = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port: candidate, host: candidate === port && host ? host : "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}
for (const candidate of [port, providerPort]) {
  if (await portInUse(candidate)) {
    console.error(`[dev:local] port ${candidate} is already in use — is another dev:local still running? Stop it, or pass --port=<n>.`);
    process.exit(1);
  }
}

if (args.has("--reset")) {
  rmSync(stateDir, { recursive: true, force: true });
  console.log("[dev:local] local store wiped");
}

if (!args.has("--no-build")) {
  const build = spawnSync("npx", ["astro", "build"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const providers = await startDevProviders(providerPort);
const providerBase = `http://127.0.0.1:${providerPort}`;

mkdirSync(`${root}.wrangler`, { recursive: true });
writeFileSync(envFile, "");

// The built config without `routes`: with a route, wrangler dev rewrites every
// request URL's host to the route's zone (`belanja.cc`), and the gate — which
// reads the request's own host — would see one host for every tenant. The copy
// sits beside the built config so its relative paths still resolve.
const builtConfig = `${root}dist/server/wrangler.json`;
const devConfig = `${root}dist/server/wrangler.dev-local.json`;
const { routes: _routes, ...withoutRoutes } = JSON.parse(readFileSync(builtConfig, "utf8"));
writeFileSync(devConfig, JSON.stringify(withoutRoutes));

// The provider stand-ins are a tenant's saved settings, not Worker env (T-45):
// a seeded tenant stores this base URL and a dummy key in its own store.

const worker = spawn(
  "npx",
  [
    "wrangler", "dev", "--local",
    "-c", devConfig,
    "--port", String(port),
    ...(host ? ["--ip", host] : []),
    "--persist-to", stateDir,
    "--env-file", envFile,
    // Exposes /cdn-cgi/handler/scheduled?cron=7+*+*+*+* to run the hourly job by hand.
    // The local platform host. Tenants answer on `<slug>.localhost`, which
    // Chrome treats as a secure context, so the `__Host-` session cookie is set,
    // sent and deleted there (T-22, proven in a real browser 2026-11-16).
    "--var", "PLATFORM_HOSTS:app.localhost",
    // Seller hosts are <slug>.localhost; signup's Turnstile and the custom
    // hostname API answer from the local stand-ins (scripts/dev-providers.ts).
    "--var", "TENANT_HOST_SUFFIX:localhost",
    // Platform admin sessions (IAM-3); a fixed local value, never a deployed one.
    "--var", "PLATFORM_AUTH_SECRET:dev-local-platform-auth-secret-0123456789",
    "--var", "TURNSTILE_SITE_KEY:local-stand-in",
    "--var", "TURNSTILE_SECRET_KEY:local-stand-in-secret",
    "--var", `TURNSTILE_VERIFY_URL:${providerBase}/turnstile/v0/siteverify`,
    "--var", "CF_SAAS_ZONE_ID:dev-zone",
    "--var", "CF_SAAS_TOKEN:dev-token",
    "--var", `CF_API_BASE:${providerBase}/client/v4`,
    ...(args.has("--platform-pixel")
      ? [
          "--var", "PLATFORM_META_PIXEL_ID:100000000000001",
          "--var", "PLATFORM_META_CAPI_TOKEN:dev-platform-capi-token",
          "--var", `PLATFORM_META_GRAPH_BASE:${providerBase}/graph`,
        ]
      : []),
    "--test-scheduled",
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, stdio: "inherit" },
);

console.log(`
  AdsBookCMS local store
  ─────────────────────────────────────────────
  Platform   http://app.localhost:${port}/platform/signup
  Tenants    http://<slug>.localhost:${port}   (a tenant exists once PLATFORM_DB names it)
  Providers  ${providerBase}   (Mengantar + AutoLaris stand-ins)
  Cron       http://${host || "localhost"}:${port}/cdn-cgi/handler/scheduled?cron=7+*+*+*+*
  Settle     curl -X POST '${providerBase}/__dev/autolaris/pay?transaction_id=<id>'
  Reset      npm run dev:local -- --reset
`);

const stop = () => {
  worker.kill("SIGINT");
  providers.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
worker.on("exit", (code) => {
  providers.close();
  process.exit(code ?? 0);
});
