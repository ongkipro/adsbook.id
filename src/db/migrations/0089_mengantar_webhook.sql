-- Spec A Phase 2 (D-1..D-4): Mengantar per-tenant webhook secret (ADR-040 sealed),
-- webhook event log with dedupe key, cnote lookup index, and event ordering columns.
ALTER TABLE `stores` ADD COLUMN `mengantar_webhook_secret` text;--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `provider_status_category` text;--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `provider_event_at` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_orders_cnote_no` ON `orders` (`cnote_no`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mengantar_webhook_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `received_at` text NOT NULL,
  `event_at` text NOT NULL,
  `cnote_no` text NOT NULL,
  `provider_order_id` text,
  `status_category` text NOT NULL,
  `body_sha256` text NOT NULL,
  `outcome` text NOT NULL,
  `order_id` integer,
  UNIQUE (`cnote_no`, `status_category`, `event_at`)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mengantar_webhook_events_received_at` ON `mengantar_webhook_events` (`received_at`);
