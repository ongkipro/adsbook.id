import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  dashboardOutgoingPeriodQuery,
  parseDashboardSearchParams,
} from "./dashboard-analytics.ts";
import {
  jakartaDateSql,
  jakartaDaySql,
  jakartaHourBucketSql,
  jakartaStrftimeSql,
} from "./insights-period.ts";
import { abandonedListFilter } from "./order-list-filter.ts";

test("AN-6: Jakarta +7 hours SQL offset lives in insights-period.ts alone", () => {
  assert.equal(jakartaDateSql("o.created_at"), "date(o.created_at, '+7 hours')");
  assert.equal(jakartaDaySql(), "date(created_at, '+7 hours')");
  assert.equal(jakartaHourBucketSql(), "STRFTIME('%Y-%m-%d %H:00:00', created_at, '+7 hours')");
  assert.equal(jakartaStrftimeSql("%H"), "strftime('%H', created_at, '+7 hours')");

  const files = [...globSync("src/lib/*.ts"), ...globSync("src/pages/**/*.ts")]
    .filter((file) => !file.endsWith(".test.ts") && file !== "src/lib/insights-period.ts");
  const stray = files.filter((file) => /['"]\+7 hours['"]/.test(readFileSync(file, "utf8")));
  assert.deepEqual(stray, [], "no literal '+7 hours' outside insights-period.ts");
});

test("RT-1 & AN-3: dashboard outgoing period links use shared date_filter params and dashboard parses both vocabularies", () => {
  assert.equal(
    dashboardOutgoingPeriodQuery({ filter: "last_month", start: "", end: "" }, { start_date: "2026-10-01", end_date: "2026-10-31" }),
    "date_filter=last_month",
  );
  assert.equal(
    dashboardOutgoingPeriodQuery({ filter: "custom", start: "2026-11-01", end: "2026-11-10" }, { start_date: "2026-11-01", end_date: "2026-11-10" }),
    "date_filter=custom&date_start=2026-11-01&date_end=2026-11-10",
  );
  assert.equal(
    dashboardOutgoingPeriodQuery({ filter: "all", start: "", end: "" }, { start_date: null, end_date: null }),
    "",
  );

  // Dashboard reads both `preset/start/end` and `date_filter/date_start/date_end`
  const fromDateFilter = parseDashboardSearchParams(new URLSearchParams("date_filter=last_month"));
  assert.equal(fromDateFilter.selection.filter, "last_month");

  const fromCustomDateFilter = parseDashboardSearchParams(
    new URLSearchParams("date_filter=custom&date_start=2026-11-01&date_end=2026-11-15"),
  );
  assert.deepEqual(fromCustomDateFilter.selection, {
    filter: "custom",
    start: "2026-11-01",
    end: "2026-11-15",
  });
});

test("RT-1: abandonedListFilter accepts and validates date_filter period parameters", () => {
  const all = abandonedListFilter(new URLSearchParams());
  assert.equal(all.ok, true);
  assert.equal(all.conditions.length, 1);

  const custom = abandonedListFilter(
    new URLSearchParams("date_filter=custom&date_start=2026-11-01&date_end=2026-11-14"),
  );
  assert.equal(custom.ok, true);
  assert.ok(custom.conditions.some((sql) => sql.includes("date(o.created_at, '+7 hours') BETWEEN ? AND ?")));
  assert.deepEqual(custom.params, ["2026-11-01", "2026-11-14"]);

  const invalid = abandonedListFilter(new URLSearchParams("date_filter=invalid_range"));
  assert.equal(invalid.ok, false);
});
