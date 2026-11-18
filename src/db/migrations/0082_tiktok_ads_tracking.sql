-- TikTok Pixel + Events API (Phase 1 of the deep-tracking blueprint,
-- docs/contracts/tracking/11-tiktok-and-google-deep-tracking.md §2).
-- The access token is stored sealed (ADR-040, `sealCredential`), never plain.
-- `tiktok_cod_trigger` is when a COD order becomes a TikTok CompletePayment:
-- 'order_created' (as Meta, ADR-036) or 'delivered' (as the Google upload).
ALTER TABLE `stores` ADD COLUMN `tiktok_pixel_id` text;--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `tiktok_access_token` text;--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `tiktok_test_event_code` text;--> statement-breakpoint
ALTER TABLE `stores` ADD COLUMN `tiktok_cod_trigger` text NOT NULL DEFAULT 'order_created';--> statement-breakpoint
-- Mirrors `capi_event_outbox` after 0057: keyed on (event_name, event_id), so
-- a funnel event can never occupy a CompletePayment's order-number id.
CREATE TABLE `tiktok_event_outbox` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` text NOT NULL,
  `event_name` text NOT NULL,
  `payload` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 8 NOT NULL,
  `last_error` text,
  `next_retry_at` text NOT NULL,
  `sent_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `tiktok_event_outbox_event_unique` ON `tiktok_event_outbox` (`event_name`, `event_id`);--> statement-breakpoint
CREATE INDEX `tiktok_event_outbox_status_retry_idx` ON `tiktok_event_outbox` (`status`, `next_retry_at`);
