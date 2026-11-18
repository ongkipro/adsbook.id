-- Google Ads Phase 2 (tracking chapter 11 §3): the Data Manager API path and the
-- seller's COD trigger.
--
-- `google_ads_api_mode`: 'data_manager' (events:ingest, no developer token) or
-- 'ads_api' (the v25 uploadClickConversions this store may already run). A store
-- that saved a developer token keeps the Ads API, so nothing changes for it on
-- upgrade; every other store starts on the Data Manager API.
-- `google_ads_cod_trigger`: 'delivered' (the existing contract, the default) or
-- 'order_created'.
ALTER TABLE `stores` ADD COLUMN `google_ads_api_mode` text NOT NULL DEFAULT 'data_manager';--> statement-breakpoint
UPDATE `stores` SET `google_ads_api_mode` = CASE WHEN TRIM(COALESCE(`google_ads_developer_token`, '')) <> '' THEN 'ads_api' ELSE 'data_manager' END;--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `google_ads_cod_trigger` text NOT NULL DEFAULT 'delivered';--> statement-breakpoint
-- The outbox's qualification CHECK gains 'cod_created' (a COD order uploaded at
-- creation). SQLite cannot alter a CHECK, so the table is rebuilt: same
-- columns, rows copied as they are, the same two indexes.
CREATE TABLE `google_ads_conversion_outbox_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` integer NOT NULL,
  `order_number` text NOT NULL,
  `qualification` text NOT NULL CHECK (`qualification` IN ('online_paid', 'cod_delivered', 'cod_created')),
  `payload` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending', 'sent', 'failed')),
  `attempts` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 5 NOT NULL,
  `last_error` text,
  `next_retry_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `google_ads_conversion_outbox_new`
  (`id`, `order_id`, `order_number`, `qualification`, `payload`, `status`, `attempts`, `max_attempts`, `last_error`, `next_retry_at`, `created_at`, `updated_at`)
  SELECT `id`, `order_id`, `order_number`, `qualification`, `payload`, `status`, `attempts`, `max_attempts`, `last_error`, `next_retry_at`, `created_at`, `updated_at`
  FROM `google_ads_conversion_outbox`;--> statement-breakpoint
-- AUTOINCREMENT ids are never reused: the 30-day purge can leave the table empty
-- or below its high-water mark, and DROP TABLE deletes that mark. So the new
-- table's counter is raised to the old one's first (the row the rename then
-- carries over). Review 2026-11-18; checked on node:sqlite and workerd DO SQLite.
INSERT INTO sqlite_sequence (`name`, `seq`)
  SELECT 'google_ads_conversion_outbox_new', 0
  WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE `name` = 'google_ads_conversion_outbox_new');--> statement-breakpoint
UPDATE sqlite_sequence
  SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM sqlite_sequence WHERE `name` = 'google_ads_conversion_outbox'), 0))
  WHERE `name` = 'google_ads_conversion_outbox_new';--> statement-breakpoint
DROP TABLE `google_ads_conversion_outbox`;--> statement-breakpoint
ALTER TABLE `google_ads_conversion_outbox_new` RENAME TO `google_ads_conversion_outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_conversion_outbox_order_unique`
  ON `google_ads_conversion_outbox` (`order_id`);--> statement-breakpoint
CREATE INDEX `google_ads_conversion_outbox_due_idx`
  ON `google_ads_conversion_outbox` (`status`, `next_retry_at`);
