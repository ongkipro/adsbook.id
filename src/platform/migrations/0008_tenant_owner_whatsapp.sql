-- Owner WhatsApp captured optionally at signup (UX-1, ADR-041): feeds the
-- store's default CS WhatsApp rotator AND guarantees a valid customer_phone
-- when the owner creates a subscription invoice before configuring a warehouse.
ALTER TABLE tenants ADD COLUMN owner_whatsapp TEXT;
