/**
 * `npm run platform:user -- --email=ops@example.com --role=platform_owner`
 * creates a platform admin user (T-27) on the LOCAL dev:local control plane
 * and prints its TOTP enrolment. Local only: it refuses --remote, and it
 * never touches a deployed PLATFORM_DB (that is an approval-gated live action,
 * T-30). Run it while dev:local is up (the control plane exists once the
 * Worker has answered one request).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashAdminPassword } from "../src/lib/admin-credentials.ts";
import { newTotpSecret, otpauthUri } from "../src/platform/admin/totp.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith("--remote"))) {
  console.error("[platform:user] refusing --remote: this script only writes the local dev:local control plane.");
  process.exit(1);
}
const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const email = (value("email") || "").trim().toLowerCase();
const role = value("role") || "platform_owner";
const password = value("password") || "";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["platform_owner", "platform_support"].includes(role) || password.length < 12) {
  console.error("usage: --email=<email> --role=platform_owner|platform_support --password=<12+ characters>");
  process.exit(1);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const config = `${root}dist/server/wrangler.dev-local.json`;
if (!existsSync(config)) {
  console.error("[platform:user] start `npm run dev:local` first (it writes the local config).");
  process.exit(1);
}
const secret = newTotpSecret();
const id = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const sql = `INSERT INTO platform_users (id, email, password_hash, totp_secret, role, created_at) VALUES (${[
  id, email, await hashAdminPassword(password), secret, role, new Date().toISOString(),
].map(quote).join(", ")});`;
const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "PLATFORM_DB", "--local", "-c", config, "--persist-to", `${root}.wrangler/dev-local-state`, "--command", sql],
  { cwd: root, encoding: "utf8" },
);
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
console.log(`[platform:user] ${email} (${role}) created on the local control plane.`);
console.log(`[platform:user] TOTP secret: ${secret}`);
console.log(`[platform:user] ${otpauthUri(secret, email)}`);
