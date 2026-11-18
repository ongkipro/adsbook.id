/**
 * Signup and provisioning (T-26, PR-11), in the order of
 * MULTI-TENANT-DESIGN §3.1:
 *
 * 1. validate (slug rule and reserved list, email, optional WhatsApp, password,
 *    terms, Turnstile, per-address rate limit) — nothing is written before this;
 *    one batch inserts the tenant (`provisioning`, never routable) and its
 *    subdomain host (`pending`); the UNIQUE slug and the host key pick one
 *    winner of a race;
 * 2. create the tenant's store and apply the chain (bookmark first);
 * 3. the inherited install write in the store — the `stores` row, default
 *    courier rules, optional support WhatsApp rotator, and the **claim of the
 *    seeded credential** (zero rows claimed is a failure, IAM-10) — then the
 *    tenant's session key and its webhook token;
 * 4. one batch: tenant `active`, host `active` and primary, the `signup`
 *    event with the accepted terms version;
 * 5. a handoff token (IAM-8) for the owner's first session.
 *
 * A failure after step 1 leaves the tenant `purging` with a
 * `provision_failed` event naming the step; the purge job removes whatever
 * exists (src/platform/purge.ts). Nothing half-made is ever active.
 */
import { resolveAuthSecret } from "../lib/auth-secret.ts";
import { EMAIL_USERNAME_PATTERN } from "../lib/admin-credentials.ts";
import { runInstall } from "../lib/install.ts";
import { checkRateLimit } from "../lib/rate-limit.ts";
import { isValidWa62, normalizePhone } from "../lib/validation.ts";
import { CMS_VERSION } from "../lib/version.ts";
import { ensureControlPlane } from "./control-plane.ts";
import { issueHandoff } from "./handoff.ts";
import { tenantHostSuffix } from "./hostnames.ts";
import { checkSlug, suggestFreeSlugs } from "./slugs.ts";
import { openTenantDb } from "./tenant-db.ts";
import { issueWebhookToken } from "./webhook-secrets.ts";
import { CURRENT_LEGAL_VERSION } from "./legal-texts.ts";

/**
 * The seller terms and platform privacy notice a signup accepts (T-39,
 * PR-24): the versions served at /platform/syarat and /platform/privasi,
 * recorded on the `signup` event. An accepted version's text never changes.
 */
export const TERMS_VERSION = CURRENT_LEGAL_VERSION["seller-terms"];
export const PRIVACY_VERSION = CURRENT_LEGAL_VERSION["platform-privacy"];
export const SIGNUP_LIMIT_PER_HOUR = 5;

export type SignupInput = {
  storeName?: unknown;
  slug?: unknown;
  email?: unknown;
  whatsapp?: unknown;
  password?: unknown;
  terms?: unknown;
  turnstileToken?: unknown;
  /** AUTH-LOGIN-REGISTER-UX-SPEC §2.4: 'physical' (the default), 'digital' or 'hybrid'. */
  catalogMode?: unknown;
};

export type SignupFieldErrors = Partial<Record<"storeName" | "slug" | "email" | "whatsapp" | "password" | "terms" | "turnstile", string>>;

export type SignupPlan = {
  storeName: string;
  slug: string;
  email: string;
  whatsapp: string | null;
  password: string;
  catalogMode: "physical" | "digital" | "hybrid";
};

/** UX-1 field rules, decided before any write. */
export function planSignup(input: SignupInput): { ok: true; plan: SignupPlan } | { ok: false; errors: SignupFieldErrors; reserved?: boolean } {
  const errors: SignupFieldErrors = {};
  const storeName = typeof input.storeName === "string" ? input.storeName.trim().replace(/\s+/g, " ") : "";
  if (storeName.length < 2 || storeName.length > 80) errors.storeName = "Nama toko 2–80 karakter.";
  const slug = checkSlug(input.slug);
  if (!slug.ok) errors.slug = slug.error;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_USERNAME_PATTERN.test(email)) errors.email = "Email tidak valid.";
  const rawWhatsapp = typeof input.whatsapp === "string" ? input.whatsapp.trim() : "";
  let whatsapp: string | null = null;
  if (rawWhatsapp) {
    const normalized = normalizePhone(rawWhatsapp);
    if (!isValidWa62(normalized)) {
      errors.whatsapp = "Nomor WhatsApp harus nomor aktif Indonesia (contoh: 0812-3456-7890).";
    } else {
      whatsapp = normalized;
    }
  }
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < 10 || password.length > 128) errors.password = "Password 10–128 karakter.";
  else if (password.toLowerCase() === email) errors.password = "Password tidak boleh sama dengan email.";
  if (input.terms !== true && input.terms !== "on") errors.terms = "Setujui syarat & ketentuan untuk melanjutkan.";
  if (Object.keys(errors).length || !slug.ok) {
    return { ok: false, errors, reserved: !slug.ok && slug.reserved };
  }
  // Anything unknown is the physical default: the choice is reversible in settings.
  const catalogMode = input.catalogMode === "digital" || input.catalogMode === "hybrid" ? input.catalogMode : "physical";
  return { ok: true, plan: { storeName, slug: slug.slug, email, whatsapp, password, catalogMode } };
}

/** Cloudflare Turnstile siteverify. No secret configured: signup is closed (fail closed). */
export async function verifyTurnstile(
  env: Record<string, unknown>,
  token: unknown,
  ip: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const secret = typeof env.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY : "";
  if (!secret || typeof token !== "string" || !token || token.length > 2048) return false;
  const url = typeof env.TURNSTILE_VERIFY_URL === "string" && env.TURNSTILE_VERIFY_URL
    ? env.TURNSTILE_VERIFY_URL
    : "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip });
    const response = await fetcher(url, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    const result = (await response.json().catch(() => null)) as { success?: boolean } | null;
    return result?.success === true;
  } catch {
    return false;
  }
}

export type ProvisionStep = "reserve" | "store" | "install" | "secrets" | "handoff" | "activate";

export type SignupDeps = {
  now?: () => Date;
  verifyTurnstile?: (token: unknown, ip: string) => Promise<boolean>;
  /** Tests inject a failure after a step to prove nothing half-made goes live. */
  checkpoint?: (step: ProvisionStep, tenantId: string) => void | Promise<void>;
};

export type SignupResult =
  | { status: 201; tenantId: string; host: string; email: string; whatsapp: string | null; handoffToken: string }
  | { status: 400 | 409 | 429 | 500 | 503; error: string; errors?: SignupFieldErrors; suggestions?: string[] };

export { tenantHostSuffix };

const EMAIL_TAKEN_MESSAGE = "Email ini sudah terdaftar untuk sebuah toko. Silakan masuk, atau gunakan email lain.";
const EMAIL_TAKEN = { status: 409, error: EMAIL_TAKEN_MESSAGE, errors: { email: EMAIL_TAKEN_MESSAGE } } as const;

/** Whether this email already signs into a store, as an owner or as a staff identifier. */
async function emailTaken(platformDb: D1Database, email: string): Promise<boolean> {
  const row = await platformDb
    .prepare(
      `SELECT 1 AS yes FROM platform_identities WHERE identifier = ?
       UNION ALL SELECT 1 FROM tenants WHERE lower(owner_email) = ? AND status <> 'purged'
       LIMIT 1`,
    )
    .bind(email, email)
    .first<{ yes: number }>();
  return Boolean(row);
}

function newTenantId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `t_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export async function signup(
  env: Record<string, unknown>,
  input: SignupInput,
  ip: string,
  deps: SignupDeps = {},
): Promise<SignupResult> {
  const platformDb = env.PLATFORM_DB as D1Database | undefined;
  if (!platformDb || !env.TENANT_STORE) return { status: 503, error: "Pendaftaran belum tersedia." };
  const now = deps.now ?? (() => new Date());

  await ensureControlPlane(platformDb);
  const planned = planSignup(input);
  if (!planned.ok) {
    if (planned.reserved && Object.keys(planned.errors).length === 1) {
      const suggestions = await suggestFreeSlugs(platformDb, String(input.slug ?? input.storeName ?? ""), 3).catch(() => []);
      return { status: 409, error: "Alamat toko ini tidak tersedia.", errors: planned.errors, suggestions };
    }
    return { status: 400, error: "Periksa kembali isian formulir.", errors: planned.errors };
  }
  const { plan } = planned;

  const limit = await checkRateLimit(platformDb, `signup:${ip}`, SIGNUP_LIMIT_PER_HOUR, 60 * 60 * 1000);
  if (!limit.allowed) return { status: 429, error: "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti." };
  const human = await (deps.verifyTurnstile ?? ((token, address) => verifyTurnstile(env, token, address)))(input.turnstileToken, ip);
  if (!human) return { status: 400, error: "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", errors: { turnstile: "Verifikasi gagal." } };

  // One email, one store (AUTH-LOGIN-REGISTER-UX-SPEC §1.2). Asked after the rate
  // limit and the human check, so the answer is no cheaper to harvest than a signup.
  if (await emailTaken(platformDb, plan.email)) return EMAIL_TAKEN;

  const tenantId = newTenantId();
  const host = `${plan.slug}.${tenantHostSuffix(env)}`;
  const at = now().toISOString();
  try {
    await platformDb.batch([
      platformDb
        .prepare("INSERT INTO tenants (id, slug, owner_email, owner_whatsapp, status, plan_id, created_at) VALUES (?, ?, ?, ?, 'provisioning', 'pilot', ?)")
        .bind(tenantId, plan.slug, plan.email, plan.whatsapp, at),
      platformDb
        .prepare("INSERT INTO tenant_hosts (host, tenant_id, kind, status, is_primary, created_at) VALUES (?, ?, 'subdomain', 'pending', 0, ?)")
        .bind(host, tenantId, at),
      // The owner's sign-in identifier, in the same transaction: a second store
      // racing for this email fails here even after the check above passed.
      platformDb
        .prepare("INSERT INTO platform_identities (identifier, tenant_id, kind, created_at) VALUES (?, ?, 'owner_email', ?)")
        .bind(plan.email, tenantId, at),
    ]);
  } catch (error) {
    if (/platform_identities|owner_email/i.test(String(error))) return EMAIL_TAKEN;
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(error))) {
      const suggestions = await suggestFreeSlugs(platformDb, plan.slug, 3).catch(() => []);
      return {
        status: 409,
        error: "Alamat toko ini sudah dipakai.",
        errors: { slug: "Alamat toko ini sudah dipakai." },
        suggestions,
      };
    }
    console.error("signup-reserve-failed", { error: String(error) });
    return { status: 500, error: "Pendaftaran gagal. Coba lagi beberapa saat lagi." };
  }

  let step: ProvisionStep = "reserve";
  try {
    await deps.checkpoint?.("reserve", tenantId);
    step = "store";
    const database = await openTenantDb(env, { tenantId, cacheVersion: 1 }, CMS_VERSION.schemaVersion);
    await deps.checkpoint?.("store", tenantId);

    step = "install";
    const installed = await runInstall(database, {
      ownerEmail: plan.email,
      storeName: plan.storeName,
      siteUrl: `https://${host}`,
      slug: plan.slug,
      adminUsername: plan.email,
      adminPassword: plan.password,
      tagline: "",
      supportWhatsapp: plan.whatsapp ?? "",
      locale: "id-ID",
      storefrontTemplate: "compact-market",
    });
    if (!installed.ok) throw new Error(`install: ${installed.error}`);
    await database.prepare("UPDATE stores SET catalog_mode = ?").bind(plan.catalogMode).run();
    await deps.checkpoint?.("install", tenantId);

    step = "secrets";
    if ((await resolveAuthSecret(database, tenantId)).length < 32) throw new Error("no session key");
    await issueWebhookToken(platformDb, tenantId, "autolaris", now());
    await deps.checkpoint?.("secrets", tenantId);

    // Issued while still provisioning, so activation is the last step: a
    // failure here goes through cleanup like any other. The route only
    // redeems a token of an active tenant.
    step = "handoff";
    const handoffToken = await issueHandoff(platformDb, tenantId, host, "signup", now());
    await deps.checkpoint?.("handoff", tenantId);

    // The host and the `signup` event follow the tenant's own transition in
    // the same transaction: if the stale-provisioning job won the row first,
    // nothing here changes, and the tenant stays a never-active one.
    step = "activate";
    const active = "EXISTS (SELECT 1 FROM tenants WHERE id = ? AND status = 'active')";
    const [activated] = await platformDb.batch([
      platformDb.prepare("UPDATE tenants SET status = 'active' WHERE id = ? AND status = 'provisioning'").bind(tenantId),
      platformDb
        .prepare(`UPDATE tenant_hosts SET status = 'active', is_primary = 1 WHERE host = ? AND tenant_id = ? AND status = 'pending' AND ${active}`)
        .bind(host, tenantId, tenantId),
      platformDb
        .prepare(
          `INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json)
           SELECT ?, 'signup', ?, ?, json_object('terms_version', ?, 'privacy_version', ?) WHERE ${active}`,
        )
        .bind(tenantId, plan.email, now().toISOString(), TERMS_VERSION, PRIVACY_VERSION, tenantId),
    ]);
    if (Number(activated.meta?.changes ?? 0) !== 1) throw new Error("tenant left provisioning");
    await deps.checkpoint?.("activate", tenantId);
    return { status: 201, tenantId, host, email: plan.email, whatsapp: plan.whatsapp, handoffToken };
  } catch (error) {
    console.error("signup-provision-failed", { tenant_id: tenantId, step, error: String(error) });
    await platformDb
      .batch([
        platformDb.prepare("UPDATE tenants SET status = 'purging' WHERE id = ? AND status IN ('provisioning', 'active')").bind(tenantId),
        // The store never opened: its sign-in identifier is not its to keep.
        platformDb.prepare("DELETE FROM platform_identities WHERE tenant_id = ?").bind(tenantId),
        platformDb
          .prepare("INSERT INTO tenant_events (tenant_id, kind, actor, at, detail_json) VALUES (?, 'provision_failed', 'platform', ?, json_object('step', ?))")
          .bind(tenantId, now().toISOString(), step),
      ])
      .catch((cleanup) => console.error("signup-mark-purging-failed", { tenant_id: tenantId, error: String(cleanup) }));
    return { status: 500, error: "Pendaftaran gagal. Coba lagi beberapa saat lagi." };
  }
}
