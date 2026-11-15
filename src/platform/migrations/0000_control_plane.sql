-- Control plane (PLATFORM_DB), docs/spec/05-DATA-MODEL.md §4. One D1, never a tenant table.

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_custom_domains INTEGER NOT NULL CHECK (max_custom_domains >= 0),
  media_uploads_per_hour INTEGER NOT NULL CHECK (media_uploads_per_hour >= 0),
  ai_generations_per_hour INTEGER NOT NULL CHECK (ai_generations_per_hour >= 0)
);

-- v1 has one plan (BILL-1). The two hourly limits have no number in the spec;
-- these are the starting values, read from here by the guardrails (T-37).
INSERT INTO plans (id, name, max_custom_domains, media_uploads_per_hour, ai_generations_per_hour)
VALUES ('pilot', 'Pilot', 2, 60, 20);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'recovery', 'purging', 'purged')),
  plan_id TEXT NOT NULL DEFAULT 'pilot' REFERENCES plans (id),
  cache_version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  purge_after TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX tenants_status_schema ON tenants (status, schema_version);

CREATE TABLE tenant_hosts (
  host TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  kind TEXT NOT NULL CHECK (kind IN ('subdomain', 'custom')),
  domain_group TEXT,
  cf_custom_hostname_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  ssl_status TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  revoked_at TEXT,
  quarantine_until TEXT,
  created_at TEXT NOT NULL,
  -- Stored normalised (docs/spec/08-DOMAIN-ROUTING.md §2); the gate looks up exactly this.
  CHECK (host = lower(host) AND host NOT LIKE '%.' AND host NOT LIKE '%:%' AND length(host) <= 253)
);

CREATE INDEX tenant_hosts_tenant ON tenant_hosts (tenant_id);
CREATE UNIQUE INDEX tenant_hosts_one_primary ON tenant_hosts (tenant_id) WHERE is_primary = 1;

CREATE TABLE platform_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  role TEXT NOT NULL CHECK (role IN ('platform_owner', 'platform_support')),
  disabled_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE platform_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users (id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX platform_sessions_user ON platform_sessions (user_id);

CREATE TABLE tenant_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  detail_json TEXT
);

CREATE INDEX tenant_events_tenant_at ON tenant_events (tenant_id, at);
CREATE INDEX tenant_events_at ON tenant_events (at);
--> statement-breakpoint
CREATE TRIGGER tenant_events_append_only_update BEFORE UPDATE ON tenant_events
BEGIN
  SELECT RAISE(ABORT, 'tenant_events is append-only');
END;
--> statement-breakpoint

CREATE TABLE migration_bookmarks (
  tenant_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  bookmark TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, schema_version)
);

CREATE TABLE webhook_secrets (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  provider TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE handoff_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'owner_recovery')),
  host TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX handoff_tokens_expires ON handoff_tokens (expires_at);

CREATE TABLE tenant_usage_daily (
  tenant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  orders INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  media_bytes INTEGER NOT NULL DEFAULT 0,
  custom_hostnames INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE tenant_health (
  tenant_id TEXT PRIMARY KEY,
  heartbeat_at TEXT,
  outbox_backlog INTEGER,
  last_error TEXT,
  snapshot_json TEXT
);
