-- ADR-039 amendment (c), 2026-11-16: the seller zone moved from adsbook.cc
-- (its Cloudflare IPs were on Indonesia's Trust+ list) to adsbook.my.id.
-- A store's own subdomain is a tenant_hosts row, so stores that signed up on
-- the old zone move with it: same slug, new suffix. Custom domains are not
-- touched; their CNAME target is renamed in the product copy. Forward data
-- migration: nothing earlier is edited.
UPDATE tenant_hosts
SET host = substr(host, 1, length(host) - length('.adsbook.cc')) || '.adsbook.my.id'
WHERE kind = 'subdomain' AND host LIKE '%.adsbook.cc';
