-- PR-29 (T-44): one operator notice per event. The primary key is the "once";
-- no retention job touches this table, so a notice never repeats.
CREATE TABLE operator_notices (
  tenant_id TEXT NOT NULL,
  notice TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, notice)
);
