-- Paduka, 2026-11-16: one store = one custom domain ("pastikan pertenant ini
-- per domain. jadi seller kalo mau nambah domain wajib berlangganan lagi").
-- A main domain and its `www` share one domain_group and still count as one
-- (up to two Cloudflare custom hostnames); a second distinct domain needs
-- another store. Forward migration: 0000 is applied on the live PLATFORM_DB.
UPDATE plans SET max_custom_domains = 1 WHERE id = 'pilot';
