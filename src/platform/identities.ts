/**
 * The platform-wide login identifiers (AUTH-LOGIN-REGISTER-UX-SPEC §1.2,
 * control-plane migration 0010): every email or username a person signs in
 * with belongs to exactly one store, so adsbook.id/masuk can find the store
 * from what the person types. One owner email is one store; a staff username
 * or email is unique across every store.
 *
 * Routes reach `PLATFORM_DB` only through these helpers. Without a control
 * plane (a single-store test or tool) they answer `unavailable` and the
 * store's own UNIQUE constraint still guards it.
 */
import { normalizeAdminUsername } from "../lib/admin-credentials.ts";

export type IdentityKind = "owner_email" | "staff_username" | "staff_email";
/** `claimed`: inserted now (release it if the store write fails); `held`: already this store's, as this kind. */
export type ClaimResult = "claimed" | "held" | "taken" | "unavailable";

function platformDb(env: unknown): D1Database | undefined {
  const db = (env as { PLATFORM_DB?: D1Database } | null | undefined)?.PLATFORM_DB;
  return db?.prepare ? db : undefined;
}

/** The stored form of an identifier: what `normalizeAdminUsername` gives every login form. */
export function identityKey(value: unknown): string {
  return normalizeAdminUsername(value);
}

/**
 * Claims `identifier` for `tenantId`. `claimed` when this call made it this
 * store's, `held` when it already was (same kind), `taken` when any other
 * store, or another kind in this store, holds it. Call before the store writes
 * the credential, and release only a `claimed` one if that write fails.
 */
export async function claimPlatformIdentity(
  env: unknown,
  tenantId: string | undefined,
  identifier: string,
  kind: IdentityKind,
  now = new Date(),
): Promise<ClaimResult> {
  const db = platformDb(env);
  const key = identityKey(identifier);
  if (!db || !tenantId || key.length < 3) return "unavailable";
  const inserted = await db
    .prepare("INSERT INTO platform_identities (identifier, tenant_id, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (identifier) DO NOTHING")
    .bind(key, tenantId, kind, now.toISOString())
    .run();
  if (Number(inserted.meta?.changes ?? 0) === 1) return "claimed";
  const holder = await db
    .prepare("SELECT tenant_id, kind FROM platform_identities WHERE identifier = ?")
    .bind(key)
    .first<{ tenant_id: string; kind: string }>();
  return holder && holder.tenant_id === tenantId && holder.kind === kind ? "held" : "taken";
}

/**
 * Releases `identifier` if, and only if, this store holds it as `kind`: a staff
 * member removed with the owner's own email (allowed before 0010) never frees
 * the owner's sign-in.
 */
export async function releasePlatformIdentity(env: unknown, tenantId: string | undefined, identifier: string, kind: IdentityKind): Promise<void> {
  const db = platformDb(env);
  const key = identityKey(identifier);
  if (!db || !tenantId || !key) return;
  await db.prepare("DELETE FROM platform_identities WHERE identifier = ? AND tenant_id = ? AND kind = ?").bind(key, tenantId, kind).run();
}

export type ResolvedIdentity = {
  tenantId: string;
  kind: IdentityKind;
  /** The store's active platform subdomain: where the login handoff is redeemed. */
  host: string;
  cacheVersion: number;
};

/** The active store an identifier signs into, with its subdomain; null for anything else. */
export async function resolvePlatformIdentity(db: D1Database, identifier: string): Promise<ResolvedIdentity | null> {
  const key = identityKey(identifier);
  if (key.length < 3) return null;
  const row = await db
    .prepare(
      `SELECT pi.tenant_id, pi.kind, h.host, t.cache_version
         FROM platform_identities pi
         JOIN tenants t ON t.id = pi.tenant_id AND t.status = 'active'
         JOIN tenant_hosts h ON h.tenant_id = t.id AND h.kind = 'subdomain' AND h.status = 'active'
        WHERE pi.identifier = ?
        LIMIT 1`,
    )
    .bind(key)
    .first<{ tenant_id: string; kind: IdentityKind; host: string; cache_version: number }>();
  return row ? { tenantId: row.tenant_id, kind: row.kind, host: row.host, cacheVersion: Number(row.cache_version) } : null;
}
