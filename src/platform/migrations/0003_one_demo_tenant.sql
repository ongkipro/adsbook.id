-- PR-26 (T-41): exactly one demo tenant. The flag exists since 0000; this
-- makes "one" a database fact instead of a promise in a script.
CREATE UNIQUE INDEX tenants_one_demo ON tenants (is_demo) WHERE is_demo = 1;
