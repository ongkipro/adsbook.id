-- T-27 review: a TOTP code is accepted once. The last accepted 30-second step
-- is claimed atomically at sign-in; a code from that step or an older one is
-- refused even while it is still inside the clock-skew window.
ALTER TABLE platform_users ADD COLUMN totp_last_step INTEGER;
