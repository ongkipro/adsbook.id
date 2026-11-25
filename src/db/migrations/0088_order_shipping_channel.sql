-- Per-order shipping channel (docs/product/MENGANTAR-WEBHOOK-AUTOSYNC-SPEC.md §5A X-1).
--
-- 'mengantar' = dispatched through Mengantar from adsbook.id (default for stores with a Mengantar API key).
-- 'external'  = shipped outside adsbook.id (another aggregator or direct to courier); operator records courier + waybill manually.
-- Existing rows with a Mengantar shipment stay 'mengantar'. Existing rows without one stay 'mengantar' when the store has a Mengantar API key, and become 'external' when it does not.
ALTER TABLE `orders` ADD COLUMN `shipping_channel` text NOT NULL DEFAULT 'mengantar' CHECK (`shipping_channel` IN ('mengantar', 'external'));--> statement-breakpoint
UPDATE `orders`
SET `shipping_channel` = 'external'
WHERE `provider_order_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `stores` s
    WHERE s.`id` = `orders`.`store_id`
      AND (s.`mengantar_api_key` IS NULL OR TRIM(s.`mengantar_api_key`) = '')
  );
