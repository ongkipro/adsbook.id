-- Provider settings a single-tenant install kept in Worker env, now saved by
-- each tenant (T-45, TEN-4): on the platform one env value would be every
-- tenant's account. Null means not configured, and nothing is sent.
--
-- AutoLaris Create Order (`/submit`): the account's own `courir_id: 1` area
-- pair and an optional shipper email (were AUTOLARIS_ORDER_ORIGIN_ID,
-- _DESTINATION_ID, AUTOLARIS_SHIPPER_EMAIL). Without the pair the QRIS/VA rail
-- stays closed (autoLarisOrderRailGap).
ALTER TABLE `stores` ADD COLUMN `autolaris_order_origin_id` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `autolaris_order_destination_id` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `autolaris_shipper_email` text;
--> statement-breakpoint
-- Google Ads offline conversion upload (were GOOGLE_ADS_*). `start_at` is set
-- when the upload is first configured, so no historical order is backfilled.
ALTER TABLE `stores` ADD COLUMN `google_ads_customer_id` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_offline_conversion_action_id` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_login_customer_id` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_offline_start_at` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_developer_token` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_client_id` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_client_secret` text;
--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_refresh_token` text;
