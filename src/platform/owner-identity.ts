/**
 * The tenant's owner, as one defensive identity (level L0, "bound owner"):
 * the single `role = 'owner'` credential of the tenant store whose `username`
 * or `email` equals `tenants.owner_email` exactly — the comparison IAM-9's
 * owner lookup uses (`src/platform/admin/recovery.ts`). It is a name binding
 * between the store and the control plane, never proof of the mailbox:
 * `verified` is always false here.
 *
 * Fail closed, never a guess: no owner, several owners, the seeded default
 * credential, an owner bound to neither name, or another credential carrying
 * the owner's address are each a refusal with a reason. Nothing is chosen by
 * lowest id, by order, or by `platform_identities` (a derived cache, never an
 * authority). Read-only: no write, no repair, no migration. The result names
 * ids and reason codes only — never an email, username, hash or token.
 */
import { isDefaultAdminCredential } from "../lib/admin-credentials.ts";
import { desiredIdentities, identityKey } from "./identities.ts";
import { TENANT_STORE_PROTOCOL } from "./store-core.ts";
import type { TenantStoreStub } from "./tenant-db.ts";

export type OwnerCredentialRow = {
  id: number;
  username: string;
  email: string | null;
  role: string;
  passwordHash: string;
};

export type OwnerRefusal = "no_owner" | "multiple_owners" | "owner_unclaimed" | "owner_unbound" | "owner_email_shadowed";
export type BoundOwner = { credentialId: number; boundBy: "username" | "email" | "both" };

/** The pure L0 predicate over one store's credentials and the control plane's `owner_email`. */
export function resolveBoundOwner(
  ownerEmail: string | null | undefined,
  credentials: readonly OwnerCredentialRow[],
): { owner: BoundOwner } | { reason: OwnerRefusal } {
  const owners = credentials.filter((credential) => credential.role === "owner");
  if (owners.length === 0) return { reason: "no_owner" };
  if (owners.length > 1) return { reason: "multiple_owners" };
  const [owner] = owners;
  if (isDefaultAdminCredential(owner)) return { reason: "owner_unclaimed" };
  const email = typeof ownerEmail === "string" ? ownerEmail : "";
  if (!email) return { reason: "owner_unbound" };
  const byUsername = owner.username === email;
  const byEmail = owner.email === email;
  if (!byUsername && !byEmail) return { reason: "owner_unbound" };
  const shadowed = credentials.some((credential) => credential.id !== owner.id && (credential.username === email || credential.email === email));
  if (shadowed) return { reason: "owner_email_shadowed" };
  return { owner: { credentialId: owner.id, boundBy: byUsername && byEmail ? "both" : byUsername ? "username" : "email" } };
}

export type RestoredOwnerVerdict =
  | { ok: true; credentialId: number; boundBy: BoundOwner["boundBy"]; verified: false }
  | { ok: false; reason: "not_fenced" | "store_unreachable" | "schema_not_at_target" | OwnerRefusal };

/** One read of a fenced tenant: its control-plane row, then its store's credentials, then the predicate. */
async function readFencedOwner(
  platformDb: D1Database,
  stub: TenantStoreStub,
  tenantId: string,
  target: number,
): Promise<{ verdict: RestoredOwnerVerdict; ownerEmail: string; credentials: OwnerCredentialRow[] }> {
  const tenant = await platformDb
    .prepare("SELECT status, owner_email FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<{ status: string; owner_email: string }>();
  const refuse = (reason: Extract<RestoredOwnerVerdict, { ok: false }>["reason"]) => ({ verdict: { ok: false as const, reason }, ownerEmail: "", credentials: [] });
  if (!tenant || tenant.status !== "recovery") return refuse("not_fenced");
  let rows: Array<{ id: number; username: string; email: string | null; role: string; password_hash: string }>;
  try {
    const state = await stub.schemaState(TENANT_STORE_PROTOCOL);
    if (state.applied !== target || state.historyUnknown || state.recovery) return refuse("schema_not_at_target");
    // The raw store RPC, not a D1 handle: no sealed column is read here, and a
    // handle without the credential cipher is refused everywhere (T-48).
    rows = ((await stub.query(TENANT_STORE_PROTOCOL, { sql: "SELECT id, username, email, role, password_hash FROM admin_credentials", args: [] }, false)).results ??
      []) as Array<{ id: number; username: string; email: string | null; role: string; password_hash: string }>;
  } catch {
    return refuse("store_unreachable");
  }
  const credentials = rows.map((row) => ({ id: Number(row.id), username: row.username, email: row.email, role: row.role, passwordHash: row.password_hash }));
  const found = resolveBoundOwner(tenant.owner_email, credentials);
  const verdict: RestoredOwnerVerdict =
    "reason" in found ? { ok: false, reason: found.reason } : { ok: true, credentialId: found.owner.credentialId, boundBy: found.owner.boundBy, verified: false };
  return { verdict, ownerEmail: tenant.owner_email, credentials };
}

/**
 * Phase A ("pre_lock") of the restored-tenant owner check: before any
 * credential is locked, the fenced tenant must still have exactly one bound
 * owner for IAM-9 to return to. The store is read through the adapter
 * directly — never `openTenantDb`, whose schema step would migrate a store in
 * recovery. A control-plane read failure throws (no verdict). The registry is
 * not read here: after a restore it is stale by construction.
 */
export async function checkRestoredOwnerIdentity(
  platformDb: D1Database,
  stub: TenantStoreStub,
  tenantId: string,
  target: number,
): Promise<RestoredOwnerVerdict> {
  return (await readFencedOwner(platformDb, stub, tenantId, target)).verdict;
}

export type PostSyncOwnerVerdict =
  | RestoredOwnerVerdict
  | { ok: false; reason: "identity_changed" | "registry_owner_blocked" | "registry_staff_blocked" | "registry_stale" };

/**
 * Phase B ("post_sync"): after an approved reconciliation of
 * `platform_identities` (not done here), the fenced tenant passes only if
 *
 * 1. every phase A rule still holds, from one fresh read;
 * 2. the owner is the one phase A approved (`expected`). Matching numeric id
 *    and binding is a consistency check inside one fenced restore only — ids
 *    are reusable, so it is never proof of an immutable identity, and it says
 *    nothing about credential or session trust;
 * 3. no identifier the store should hold is held by another store. Collisions
 *    are read from the registry's own rows, never taken from a caller or a
 *    sync result; every one stops (v1: no override). The owner's names and
 *    staff names only get different codes, with no name in the result;
 * 4. this store's rows equal their derivation from its credentials
 *    (`desiredIdentities`), and `owner_email` names the phase A owner.
 *
 * Read-only: no sync, no repair, no event, no reopen.
 */
export async function checkPostSyncOwnerIdentity(
  platformDb: D1Database,
  stub: TenantStoreStub,
  tenantId: string,
  target: number,
  expected: BoundOwner,
): Promise<PostSyncOwnerVerdict> {
  const { verdict, ownerEmail, credentials } = await readFencedOwner(platformDb, stub, tenantId, target);
  if (!verdict.ok) return verdict;
  if (verdict.credentialId !== expected.credentialId || verdict.boundBy !== expected.boundBy) return { ok: false, reason: "identity_changed" };
  const owner = credentials.find((credential) => credential.id === verdict.credentialId)!;
  const desired = desiredIdentities(ownerEmail, credentials);
  const rows = (
    await platformDb
      .prepare(
        `SELECT identifier, tenant_id, kind, credential_id FROM platform_identities
          WHERE tenant_id = ? OR identifier IN (SELECT value FROM json_each(?))`,
      )
      .bind(tenantId, JSON.stringify([...desired.keys()]))
      .all<{ identifier: string; tenant_id: string; kind: string; credential_id: number | null }>()
  ).results ?? [];
  const ownerKeys = new Set([identityKey(ownerEmail), identityKey(owner.username), identityKey(owner.email)]);
  const foreign = rows.filter((row) => row.tenant_id !== tenantId && desired.has(row.identifier));
  if (foreign.some((row) => ownerKeys.has(row.identifier))) return { ok: false, reason: "registry_owner_blocked" };
  if (foreign.length > 0) return { ok: false, reason: "registry_staff_blocked" };
  const held = new Map(rows.filter((row) => row.tenant_id === tenantId).map((row) => [row.identifier, row]));
  if (held.size !== desired.size) return { ok: false, reason: "registry_stale" };
  for (const [key, want] of desired) {
    const got = held.get(key);
    const credentialId = got?.credential_id === null || got?.credential_id === undefined ? null : Number(got.credential_id);
    if (!got || got.kind !== want.kind || credentialId !== want.credentialId) return { ok: false, reason: "registry_stale" };
  }
  // `owner_email` → the phase A owner follows: the store has exactly one owner
  // (phase A), and `desiredIdentities` maps `owner_email` to it.
  return verdict;
}
