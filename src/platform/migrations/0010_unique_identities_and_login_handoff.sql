-- One sign-in door for every store (AUTH-LOGIN-REGISTER-UX-SPEC §1, Paduka
-- 2026-11-18): adsbook.id/masuk takes an email or username and a password and
-- finds the store itself. That needs every login identifier to name one store.
--
-- 1. One owner email, one store: unique over every store that is live or
--    reserved (checked live before this file: one store per owner_email). A
--    store being purged or purged frees it, so a signup whose provisioning
--    failed (marked purging at once) can be retried with the same email.
-- 2. platform_identities: every identifier a person signs in with — the
--    owner's email, each credential's username and email — lowercased and
--    trimmed, owned by one store and one credential (credential_id; null only
--    for an owner email reserved before the store exists). The store's rows
--    are kept equal to its credentials by src/platform/identities.ts
--    (syncTenantIdentities). Backfilled with today's owners; each store's
--    credentials join on its next sync (its hourly alarm at the latest).
-- 3. handoff_tokens gains purpose 'login' and the credential revision it
--    signs in (username, credential_id, credential_updated_at): a password
--    reset, a role change or a deleted credential voids an unspent token. The
--    table is rebuilt (SQLite cannot widen a CHECK); live tokens are kept.
CREATE UNIQUE INDEX tenants_owner_email_unique ON tenants (lower(trim(owner_email))) WHERE status NOT IN ('purging', 'purged');

CREATE TABLE platform_identities (
  identifier TEXT PRIMARY KEY NOT NULL CHECK (identifier = lower(trim(identifier)) AND length(identifier) BETWEEN 3 AND 254),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  kind TEXT NOT NULL CHECK (kind IN ('owner_email', 'staff_username', 'staff_email')),
  credential_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX platform_identities_tenant_idx ON platform_identities (tenant_id);

INSERT OR IGNORE INTO platform_identities (identifier, tenant_id, kind, created_at)
  SELECT lower(trim(owner_email)), id, 'owner_email', created_at
  FROM tenants
  WHERE status NOT IN ('purging', 'purged') AND length(trim(owner_email)) >= 3;

CREATE TABLE handoff_tokens_new (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'owner_recovery', 'login')),
  host TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  username TEXT,
  credential_id INTEGER,
  credential_updated_at TEXT
);
INSERT INTO handoff_tokens_new (token_hash, tenant_id, purpose, host, expires_at, used_at)
  SELECT token_hash, tenant_id, purpose, host, expires_at, used_at FROM handoff_tokens;
DROP TABLE handoff_tokens;
ALTER TABLE handoff_tokens_new RENAME TO handoff_tokens;
CREATE INDEX handoff_tokens_expires ON handoff_tokens (expires_at);
