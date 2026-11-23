-- The storefront is the 480px column only (owner, 2026-11-23): the business
-- is an ad tapped on a phone landing on a COD form. The full-width
-- "pasar-rapi" theme that 0086 made the default is withdrawn; every store on
-- it moves back to `compact-market`. `stores.theme_settings` (0086) stays: it
-- configures this theme's homepage. Idempotent: a re-run matches nothing.
UPDATE `stores`
SET `storefront_template` = 'compact-market'
WHERE `storefront_template` = 'pasar-rapi';
