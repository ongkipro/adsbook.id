-- Shared kecamatan → Mengantar area cache for every tenant (2026-11-18).
--
-- What is shared is public geography only: a district|city|province key, the
-- Mengantar area id, its label and postal code, and the exact resolve body
-- Mengantar returned for that district. Mengantar's area ids are the same for
-- every seller account (only rates are account-specific), so one store's
-- resolve answers every other store's buyers with no provider call. Nothing
-- about a tenant, an order, a buyer or an API key is stored here; a tenant's
-- own `mengantar_areas` rows (src/db/migrations/0071) stay in its store.
--
-- Only src/platform/shared-areas.ts reads or writes this table.
CREATE TABLE shared_mengantar_areas (
  area_key TEXT PRIMARY KEY NOT NULL,
  area_id TEXT NOT NULL CHECK (length(area_id) > 0),
  label TEXT NOT NULL,
  postal_code TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
CREATE INDEX shared_mengantar_areas_area_id_idx ON shared_mengantar_areas (area_id);
