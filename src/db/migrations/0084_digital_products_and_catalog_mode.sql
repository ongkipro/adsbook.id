-- Digital products and the adaptive catalog mode (docs/product/DIGITAL-PRODUCTS-SPEC.md §2).
--
-- `stores.catalog_mode`: 'physical', 'digital' or 'hybrid'. Every store that
-- exists before this file is 'hybrid' (§1.2): its menus and readiness do not
-- change; a new signup stores the seller's explicit choice.
-- `products.product_type`: 'physical' (every existing product) or 'digital'.
-- `products.digital_access_url` / `digital_access_note`: the paid buyer's
-- access link (https only, validated by the admin API) and instructions. Never
-- read by a public query: only the admin and a paid, non-void order's status.
-- `orders.fulfillment_type`: 'digital' for an order of digital products (no
-- address, no courier, never COD); `digital_accessed_at` stamps the buyer's
-- first open of the access link.
ALTER TABLE `stores` ADD COLUMN `catalog_mode` text NOT NULL DEFAULT 'hybrid' CHECK (`catalog_mode` IN ('physical', 'digital', 'hybrid'));--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `product_type` text NOT NULL DEFAULT 'physical' CHECK (`product_type` IN ('physical', 'digital'));--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `digital_access_url` text;--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `digital_access_note` text;--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `fulfillment_type` text NOT NULL DEFAULT 'physical' CHECK (`fulfillment_type` IN ('physical', 'digital'));--> statement-breakpoint
ALTER TABLE `orders` ADD COLUMN `digital_accessed_at` text;
