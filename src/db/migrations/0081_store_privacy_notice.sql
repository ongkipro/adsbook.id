-- The seller's own section of the storefront privacy notice (T-39, PR-24).
-- The rest of the notice is generated from the versioned template and from
-- the providers the store has enabled (PRIV-2), so a seller edit can never
-- name or hide a provider. Null means the template alone.
ALTER TABLE `stores` ADD COLUMN `privacy_notice_extra` text;
