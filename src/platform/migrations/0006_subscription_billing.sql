-- ADR-041 (T-49, PR-31, BILL-4/5/6): paid subscription per store, platform
-- AutoLaris billing. Additive: 0000–0005 are applied on the live PLATFORM_DB.
--
-- A tenant with no subscription_ends_at is in Preview Mode (signup default).
-- grace_ends_at is always subscription_ends_at + 48 hours, written together.
ALTER TABLE tenants ADD COLUMN subscription_ends_at TEXT;
ALTER TABLE tenants ADD COLUMN grace_ends_at TEXT;

-- The commercial plan. Its key stays `pilot` (tenants.plan_id defaults to it
-- and references it); its limits already match ADR-041's `pro` (0005 set one
-- custom domain), so only the display name changes.
UPDATE plans SET name = 'Pro' WHERE id = 'pilot';

-- One row per payment instruction the platform asked AutoLaris for. The
-- platform's own AutoLaris account only: never a tenant's key (BILL-3).
CREATE TABLE subscription_invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  cycle_code TEXT NOT NULL CHECK (cycle_code IN ('1m', '3m', '6m', '12m')),
  days INTEGER NOT NULL CHECK (days > 0),
  amount_idr INTEGER NOT NULL CHECK (amount_idr > 0),
  admin_fee_idr INTEGER NOT NULL DEFAULT 0 CHECK (admin_fee_idr >= 0),
  total_idr INTEGER NOT NULL CHECK (total_idr > 0),
  channel_code TEXT NOT NULL,
  provider_trx_id TEXT UNIQUE,
  qr_payload TEXT,
  virtual_account TEXT,
  payment_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  -- Set once by the settlement that credited the days; the tenant update in
  -- the same batch is conditioned on it, so a replay never credits twice.
  settlement_id TEXT,
  -- How the payment was proven: 'advice' (AutoLaris Advice read).
  settled_by TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX subscription_invoices_tenant ON subscription_invoices (tenant_id, created_at);
CREATE INDEX subscription_invoices_open ON subscription_invoices (status, expires_at);
