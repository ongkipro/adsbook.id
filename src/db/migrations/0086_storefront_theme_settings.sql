-- Admin "Tema" (2026-11-23): the store's homepage configuration for its theme.
--
-- `stores.theme_settings`: JSON, validated by `storeThemeSettingsSchema`
-- (src/lib/storefront-theme.ts) on every read and write; NULL means the
-- theme's defaults. Holds only switches and short text: which homepage
-- sections show (banner, trust strip) and the catalogue heading. The accent
-- colour stays in `stores.theme_color` (0036), the banner in
-- `storefront_content` 'home' (R1b), the theme choice in
-- `stores.storefront_template`.
--
-- Default theme: stores still on the built-in `compact-market` move to
-- `pasar-rapi`, the wide layout every store has rendered since PR #61. A
-- store that picks "Klasik" afterwards gets `compact-market` (the phone
-- column) back. Idempotent: a re-run matches nothing.
ALTER TABLE `stores` ADD `theme_settings` text;
--> statement-breakpoint
UPDATE `stores`
SET `storefront_template` = 'pasar-rapi'
WHERE `storefront_template` IS NULL OR `storefront_template` = 'compact-market';
