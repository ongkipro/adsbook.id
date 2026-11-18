-- One sign-in door for every store (AUTH-LOGIN-REGISTER-UX-SPEC §1, Paduka
-- 2026-11-18): adsbook.id/masuk takes an email or username and a password and
-- finds the store itself. That needs every login identifier to name one store.
--
-- 1. One owner email, one store: unique over every store that is not purged
--    (checked live before this file: one store per owner_email). A purged
--    store's email is free again.
-- 2. platform_identities: every identifier a person signs in with — an owner's
--    email, a staff username, a staff email — lowercased and trimmed, owned by
--    one store. Claimed before the store writes the credential, released when
--    the credential goes (src/platform/identities.ts). Backfilled with today's
--    owners; staff join as their store saves them.
-- 3. handoff_tokens gains purpose 'login' and the username it signs in, so the
--    seller host opens a session for exactly that person, owner or staff. The
--    table is rebuilt (SQLite cannot widen a CHECK); live tokens are kept.
CREATE UNIQUE INDEX tenants_owner_email_unique ON tenants (lower(owner_email)) WHERE status <> 'purged';

CREATE TABLE platform_identities (
  identifier TEXT PRIMARY KEY NOT NULL CHECK (identifier = lower(trim(identifier)) AND length(identifier) BETWEEN 3 AND 254),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  kind TEXT NOT NULL CHECK (kind IN ('owner_email', 'staff_username', 'staff_email')),
  created_at TEXT NOT NULL
);
CREATE INDEX platform_identities_tenant_idx ON platform_identities (tenant_id);

INSERT OR IGNORE INTO platform_identities (identifier, tenant_id, kind, created_at)
  SELECT lower(trim(owner_email)), id, 'owner_email', created_at
  FROM tenants
  WHERE status <> 'purged' AND length(trim(owner_email)) >= 3;

CREATE TABLE handoff_tokens_new (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'owner_recovery', 'login')),
  host TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  username TEXT
);
INSERT INTO handoff_tokens_new (token_hash, tenant_id, purpose, host, expires_at, used_at)
  SELECT token_hash, tenant_id, purpose, host, expires_at, used_at FROM handoff_tokens;
DROP TABLE handoff_tokens;
ALTER TABLE handoff_tokens_new RENAME TO handoff_tokens;
CREATE INDEX handoff_tokens_expires ON handoff_tokens (expires_at);
