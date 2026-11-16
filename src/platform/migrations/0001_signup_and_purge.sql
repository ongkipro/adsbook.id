-- T-26: signup's per-address rate limit (UX-1, API-4: 429). The same shape as
-- a tenant store's `rate_limits` (0049), so `checkRateLimit` serves both; a
-- platform window is never a tenant's.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER DEFAULT 0 NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX rate_limits_reset_idx ON rate_limits (reset_at);

-- T-26: tenants whose purge completed, swept again for 7 days (a request that
-- outlived the drain may still write an object or a key). `swept_at` is the
-- persisted cursor: each run takes the least recently swept first.
CREATE TABLE purge_sweeps (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  completed_at TEXT NOT NULL,
  swept_at TEXT
);

CREATE INDEX purge_sweeps_order ON purge_sweeps (swept_at, completed_at);
