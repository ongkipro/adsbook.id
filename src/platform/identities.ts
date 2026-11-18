/**
 * The platform-wide login identifiers (AUTH-LOGIN-REGISTER-UX-SPEC §1.2,
 * control-plane migration 0010): every email or username a person signs in
 * with belongs to exactly one store and one credential, so adsbook.id/masuk
 * can find the account from what the person types. One owner email is one
 * store; a username or a staff email is unique across every store.
 *
 * Declarative (review 2026-11-18): a route first asks whether the names it is
 * about to write are free (`checkIdentitiesAvailable`), writes the store's
 * credential, then `syncTenantIdentities` makes the store's rows equal to its
 * credentials in one batch — the owner email, every username, every non-empty
 * email, each tied to its credential id — and drops whatever no longer
 * exists. No partial failure strands a claim; a rename keeps the names that
 * are still the person's; a store's staff join the registry on its next sync.
 * A sync never takes a name another store holds.
 *
 * Routes reach `PLATFORM_DB` only through these helpers. Without a control
 * plane (a single-store test or tool) they are no-ops and the store's own
 * UNIQUE constraint still guards it.
 */
import { normalizeAdminUsername } from "../lib/admin-credentials.ts";

export type IdentityKind = "owner_email" | "staff_username" | "staff_email";

function platformDb(env: unknown): D1Database | undefined {
  const db = (env as { PLATFORM_DB?: D1Database } | null | undefined)?.PLATFORM_DB;
  return db?.prepare ? db : undefined;
}

/** The stored form of an identifier: what `normalizeAdminUsername` gives every login form. */
export function identityKey(value: unknown): string {
  return normalizeAdminUsername(value);
}

/**
 * Whether every identifier is free for `credentialId` in this store: held by
 * nobody, or held by this very credential. `credentialId` null is a credential
 * not written yet (a new staff member), which may hold nothing. True without a
 * control plane.
 */
export async function checkIdentitiesAvailable(
  env: unknown,
  tenantId: string | undefined,
  credentialId: number | null,
  identifiers: readonly string[],
): Promise<boolean> {
  const db = platformDb(env);
  const keys = [...new Set(identifiers.map(identityKey).filter((key) => key.length >= 3))];
  if (!db || !tenantId || keys.length === 0) return true;
  const rows = await db
    .prepare(`SELECT tenant_id, credential_id FROM platform_identities WHERE identifier IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ tenant_id: string; credential_id: number | null }>();
  return (rows.results ?? []).every((row) => row.tenant_id === tenantId && credentialId !== null && row.credential_id === credentialId);
}

type CredentialRow = { id: number; username: string; email: string | null; role: string };

/** The rows a store should hold: its owner email first, then usernames, then emails; the first claimant of a name keeps it. */
export function desiredIdentities(ownerEmail: string, credentials: readonly CredentialRow[]) {
  const owner = credentials.find((credential) => credential.role === "owner") ?? null;
  const desired = new Map<string, { kind: IdentityKind; credentialId: number | null }>();
  const add = (identifier: string | null | undefined, kind: IdentityKind, credentialId: number | null) => {
    const key = identityKey(identifier);
    if (key.length >= 3 && !desired.has(key)) desired.set(key, { kind, credentialId });
  };
  add(ownerEmail, "owner_email", owner?.id ?? null);
  const ordered = [...credentials].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : a.id - b.id));
  for (const credential of ordered) add(credential.username, "staff_username", credential.id);
  for (const credential of ordered) add(credential.email, "staff_email", credential.id);
  return desired;
}

/**
 * Makes this store's `platform_identities` equal to its credentials, in one
 * batch. A name another store holds is skipped (never taken) and reported.
 */
export async function syncTenantIdentities(
  env: unknown,
  tenantId: string | undefined,
  tenantDb: D1Database,
  now = new Date(),
): Promise<{ synced: number; blocked: string[] }> {
  const db = platformDb(env);
  if (!db || !tenantId) return { synced: 0, blocked: [] };
  const tenant = await db.prepare("SELECT owner_email FROM tenants WHERE id = ?").bind(tenantId).first<{ owner_email: string }>();
  if (!tenant) return { synced: 0, blocked: [] };
  const credentials = (await tenantDb.prepare("SELECT id, username, email, role FROM admin_credentials").all<CredentialRow>()).results ?? [];
  const desired = desiredIdentities(tenant.owner_email, credentials);
  const keys = [...desired.keys()];
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(`DELETE FROM platform_identities WHERE tenant_id = ?${keys.length ? ` AND identifier NOT IN (${keys.map(() => "?").join(", ")})` : ""}`)
      .bind(tenantId, ...keys),
    ...keys.map((key) => {
      const row = desired.get(key)!;
      return db
        .prepare(
          `INSERT INTO platform_identities (identifier, tenant_id, kind, credential_id, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (identifier) DO UPDATE SET kind = excluded.kind, credential_id = excluded.credential_id
           WHERE platform_identities.tenant_id = excluded.tenant_id`,
        )
        .bind(key, tenantId, row.kind, row.credentialId, at);
    }),
  ]);
  const held = await db
    .prepare("SELECT identifier FROM platform_identities WHERE tenant_id = ?")
    .bind(tenantId)
    .all<{ identifier: string }>();
  const ours = new Set((held.results ?? []).map((row) => row.identifier));
  return { synced: ours.size, blocked: keys.filter((key) => !ours.has(key)) };
}

export type ResolvedIdentity = {
  tenantId: string;
  kind: IdentityKind;
  /** The credential this name signs in; null for an owner email before its store's first sync. */
  credentialId: number | null;
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
      `SELECT pi.tenant_id, pi.kind, pi.credential_id, h.host, t.cache_version
         FROM platform_identities pi
         JOIN tenants t ON t.id = pi.tenant_id AND t.status = 'active'
         JOIN tenant_hosts h ON h.tenant_id = t.id AND h.kind = 'subdomain' AND h.status = 'active'
        WHERE pi.identifier = ?
        LIMIT 1`,
    )
    .bind(key)
    .first<{ tenant_id: string; kind: IdentityKind; credential_id: number | null; host: string; cache_version: number }>();
  return row
    ? { tenantId: row.tenant_id, kind: row.kind, credentialId: row.credential_id === null ? null : Number(row.credential_id), host: row.host, cacheVersion: Number(row.cache_version) }
    : null;
}
