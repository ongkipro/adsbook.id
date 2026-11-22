-- T-57 / PR-35: optional seller two-step verification (TOTP), per credential.
--
-- `admin_credentials.totp_secret`: the authenticator secret, sealed with the
-- platform credential key (`enc:v1:…`, ADR-040), NULL while two-step is off.
-- `admin_credentials.totp_last_step`: the last 30-second step accepted, so a
-- code signs in once (replay).
-- `admin_credentials.recovery_codes`: JSON array of SHA-256 digests of the
-- one-time recovery codes shown once at enrollment; a used code is removed.
--
-- `admin_login_challenges`: the step between a correct password and the code.
-- One row per pending sign-in, keyed by the SHA-256 of an opaque token held by
-- the browser (a short-lived HttpOnly cookie on /hello, the page's memory on
-- adsbook.id/masuk). It names the credential revision it is for, so a password
-- or role change voids it, and it dies after 5 minutes or 5 wrong codes.
ALTER TABLE `admin_credentials` ADD COLUMN `totp_secret` text;--> statement-breakpoint
ALTER TABLE `admin_credentials` ADD COLUMN `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `admin_credentials` ADD COLUMN `recovery_codes` text;--> statement-breakpoint
CREATE TABLE `admin_login_challenges` (
  `token_hash` text PRIMARY KEY NOT NULL,
  `credential_id` integer NOT NULL,
  `credential_updated_at` text NOT NULL,
  `attempts` integer NOT NULL DEFAULT 0,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `admin_login_challenges_expires_idx` ON `admin_login_challenges` (`expires_at`);
