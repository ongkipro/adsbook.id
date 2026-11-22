-- T-53 (IAM-11): single-use credential grants for platform operators.
-- An owner issues a password-setup link for another operator (purpose
-- `password_reset`, keeps the enrolled TOTP) or for a new operator
-- (`enrollment`, sets password and TOTP). Only the SHA-256 of the link token
-- is stored. `consumed_by` is the consuming attempt's nonce: the one fence
-- every write of that attempt checks, so two attempts in the same
-- millisecond still cannot both pass.
-- `platform_users.credential_generation` moves with every event that revokes
-- an operator's sessions (password change, grant issued or used, disable). A
-- sign-in issues its session only if the generation it verified against still
-- holds, so a sign-in in flight cannot outlive a revocation that committed
-- before its session row.
-- Additive: one new table and one defaulted column; no existing row or
-- relationship changes, and a Worker built before this migration reads neither.
CREATE TABLE platform_credential_grants (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('password_reset', 'enrollment')),
  user_id TEXT NOT NULL REFERENCES platform_users (id),
  actor_id TEXT NOT NULL REFERENCES platform_users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  revoked_at TEXT
);
CREATE INDEX platform_credential_grants_user ON platform_credential_grants (user_id);
ALTER TABLE platform_users ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0;
