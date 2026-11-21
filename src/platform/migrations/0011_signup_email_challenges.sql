-- DRAFT (T-58 / PR-11). Not a numbered migration: the supervisor allocates the
-- control-plane migration ID (0011 is claimed by another candidate), moves this
-- file into src/platform/migrations/ and bumps PLATFORM_SCHEMA_VERSION.
--
-- One row per signup email challenge. Nothing here is the code, the address or
-- the challenge id: `challenge_id_hash` is SHA-256 of the opaque id,
-- `email_digest` and `code_digest` are keyed digests (src/platform/signup-verification.ts).
-- States: issued (row written, mail not yet confirmed) -> sent (claimable) ->
-- consumed | exhausted | superseded; issued -> void when the send failed.
CREATE TABLE signup_email_challenges (
  challenge_id_hash TEXT PRIMARY KEY NOT NULL CHECK (length(challenge_id_hash) = 64),
  email_digest TEXT NOT NULL CHECK (length(email_digest) = 64),
  code_digest TEXT NOT NULL CHECK (length(code_digest) = 64),
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'sent', 'consumed', 'exhausted', 'superseded', 'void')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT,
  consumed_at INTEGER,
  CHECK ((state = 'consumed') = (consumed_by IS NOT NULL))
);
-- The per-address cap and resend gap count by address and time.
CREATE INDEX signup_email_challenges_email_idx ON signup_email_challenges (email_digest, created_at);
CREATE INDEX signup_email_challenges_expiry_idx ON signup_email_challenges (expires_at);
