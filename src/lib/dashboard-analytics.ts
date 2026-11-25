import {
  ADMIN_CUSTOM_DATE_FILTER,
  ADMIN_DEFAULT_DATE_FILTER,
  daysBetweenAdminDates,
  isAdminDateFilter,
  isCalendarDate,
  resolveAdminDateSelection,
  type AdminDateFilter,
  type AdminDateInterval,
} from "./admin-date-filter.ts";
import {
  compareCutoff,
  compareRange,
  defaultCompareMode,
  isCompareMode,
  type CompareMode,
} from "./dashboard-compare.ts";
import { landingRanking, productRanking } from "./insights.ts";
import { jakartaDaySql, jakartaHourBucketSql, periodClause } from "./insights-period.ts";
import { LEAD_ROW, ORDER_ROW, RELEASED_ORDER } from "./order-metrics.ts";

export const DASHBOARD_MAX_RANGE_DAYS = 31;
export const DASHBOARD_HIDDEN_PRESETS = ["90d", "180d"] as const;

export type DashboardCompareChoice = "auto" | CompareMode;
export type DashboardDateSelection = {
  filter: AdminDateFilter | typeof ADMIN_CUSTOM_DATE_FILTER;
  start: string;
  end: string;
};

export type DashboardTrendPoint = { date: string; revenue: number; orders: number };
export type DashboardPaymentBucket = { count: number; percentage: number };
export type DashboardRankingRow = { label: string; revenue: number; orders?: number; units?: number };
export type DashboardRankings = { products: DashboardRankingRow[]; pages: DashboardRankingRow[] };

export type DashboardAnalyticsData = {
  total_revenue: number;
  collected_revenue: number;
  cod_revenue: number;
  prepaid_revenue: number;
  total_orders: number;
  live_orders: number;
  online_orders: number;
  average_order_value: number;
  lead_conversion_rate: number;
  lead_base: number;
  conversion_rate: number;
  rts_rate: number;
  rts_base: number;
  cod_percentage: number;
  transfer_percentage: number;
  qris_percentage: number;
  payment_methods: {
    total: number;
    cod: DashboardPaymentBucket;
    manual_transfer: DashboardPaymentBucket;
    virtual_account: DashboardPaymentBucket;
    qris: DashboardPaymentBucket;
    unknown_count: number;
  };
  period: {
    start_date: string | null;
    end_date: string | null;
    timezone: "Asia/Jakarta";
    basis: "order_created_at";
    interval: AdminDateInterval;
  };
  trends: DashboardTrendPoint[];
  funnel: {
    leads: number;
    orders: number;
    handed_over: number;
    delivered: number;
    returned: number;
  };
  previous: {
    mode: CompareMode;
    start_date: string;
    end_date: string;
    partial: boolean;
    total_revenue: number;
    live_orders: number;
    average_order_value: number;
    lead_conversion_rate: number;
    lead_base: number;
    conversion_rate: number;
    online_orders: number;
    rts_rate: number;
    rts_base: number;
    trends: DashboardTrendPoint[];
  } | null;
  rankings?: DashboardRankings | null;
};

type AnalyticsRow = {
  total_orders: number | string | null;
  total_revenue: number | string | null;
  collected_revenue: number | string | null;
  live_orders: number | string | null;
  online_orders: number | string | null;
  delivered_orders: number | string | null;
  returned_orders: number | string | null;
  paid_orders: number | string | null;
  cod_orders: number | string | null;
  manual_transfer_orders: number | string | null;
  virtual_account_orders: number | string | null;
  qris_orders: number | string | null;
  unknown_payment_orders: number | string | null;
  handed_over_orders: number | string | null;
  cod_revenue: number | string | null;
};

type TrendRow = {
  date: string;
  revenue: number | string | null;
  orders: number | string | null;
};

export function parseDashboardSearchParams(searchParams: URLSearchParams): {
  selection: DashboardDateSelection;
  compare: DashboardCompareChoice;
} {
  // Accept both dashboard's `preset/start/end` and the shared `date_filter/date_start/date_end` vocabulary (AN-3).
  const rawPreset = (searchParams.get("preset") || searchParams.get("date_filter") || "").trim();
  const rawStart = (searchParams.get("start") || searchParams.get("date_start") || "").trim();
  const rawEnd = (searchParams.get("end") || searchParams.get("date_end") || "").trim();
  const rawCompare = (searchParams.get("compare") || "").trim();

  let selection: DashboardDateSelection = {
    filter: ADMIN_DEFAULT_DATE_FILTER,
    start: "",
    end: "",
  };

  if (rawPreset === ADMIN_CUSTOM_DATE_FILTER && isCalendarDate(rawStart) && isCalendarDate(rawEnd)) {
    const check = resolveAdminDateSelection(ADMIN_CUSTOM_DATE_FILTER, {
      customRange: { start: rawStart, end: rawEnd },
      maxCustomRangeDays: DASHBOARD_MAX_RANGE_DAYS,
    });
    if (check.ok) {
      selection = { filter: ADMIN_CUSTOM_DATE_FILTER, start: rawStart, end: rawEnd };
    }
  } else if (
    rawPreset &&
    isAdminDateFilter(rawPreset) &&
    !(DASHBOARD_HIDDEN_PRESETS as readonly string[]).includes(rawPreset)
  ) {
    selection = { filter: rawPreset, start: "", end: "" };
  }

  const compare: DashboardCompareChoice = isCompareMode(rawCompare) ? rawCompare : "auto";
  return { selection, compare };
}

export function buildDashboardUrlSearch(
  selection: { filter: string; start: string; end: string },
  compare: DashboardCompareChoice,
): string {
  const params = new URLSearchParams();
  if (selection.filter !== ADMIN_DEFAULT_DATE_FILTER) {
    params.set("preset", selection.filter);
    if (selection.filter === ADMIN_CUSTOM_DATE_FILTER && selection.start && selection.end) {
      params.set("start", selection.start);
      params.set("end", selection.end);
    }
  }
  if (compare !== "auto") {
    params.set("compare", compare);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * Outgoing period query string for links from Dashboard into Orders, Shipping,
 * Abandoned Leads, and Analitik (RT-1, AN-3). Uses the shared `date_filter` /
 * `date_start` / `date_end` vocabulary; returns "" for "all" so Analitik falls
 * back to its default instead of refusing an unbounded range.
 */
export function dashboardOutgoingPeriodQuery(
  selection: { filter: string; start: string; end: string },
  period: { start_date: string | null; end_date: string | null },
): string {
  if (selection.filter === "all") return "";
  if (selection.filter === ADMIN_CUSTOM_DATE_FILTER) {
    const start = selection.start || period.start_date;
    const end = selection.end || period.end_date;
    return start && end ? `date_filter=custom&date_start=${start}&date_end=${end}` : "";
  }
  if (isAdminDateFilter(selection.filter)) {
    return `date_filter=${selection.filter}`;
  }
  return period.start_date && period.end_date
    ? `date_filter=custom&date_start=${period.start_date}&date_end=${period.end_date}`
    : "";
}

function buildTrends(
  rows: TrendRow[],
  start: string | null,
  end: string | null,
  interval: AdminDateInterval,
): DashboardTrendPoint[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const bucket = (date: string) => {
    const match = byDate.get(date);
    return { date, revenue: Number(match?.revenue ?? 0), orders: Number(match?.orders ?? 0) };
  };
  const out: DashboardTrendPoint[] = [];
  if (start && end && interval === "hour") {
    for (let hour = 0; hour < 24; hour += 1) {
      out.push(bucket(`${start} ${String(hour).padStart(2, "0")}:00:00`));
    }
    return out;
  }
  const first = start ?? rows[0]?.date;
  const last = end ?? rows[rows.length - 1]?.date;
  if (!first || !last) return out;
  const cursor = new Date(`${first}T00:00:00.000Z`);
  const stop = new Date(`${last}T00:00:00.000Z`);
  while (cursor.getTime() <= stop.getTime()) {
    out.push(bucket(cursor.toISOString().slice(0, 10)));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function summarySelectSql(whereClause: string) {
  return `
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN ${RELEASED_ORDER} THEN 0 ELSE total_amount END), 0) AS total_revenue,
      COALESCE(SUM(CASE
        WHEN payment_status IN ('paid', 'settled', 'success')
        THEN total_amount
          - COALESCE(shipping_cost, 0)
          - COALESCE(cod_service_fee, 0)
          - COALESCE(cod_service_fee_vat, 0)
        ELSE 0 END), 0) AS collected_revenue,
      COALESCE(SUM(CASE WHEN ${RELEASED_ORDER} THEN 0 ELSE 1 END), 0) AS live_orders,
      COALESCE(SUM(CASE WHEN payment_method <> 'cod' THEN 1 ELSE 0 END), 0) AS online_orders,
      COALESCE(SUM(CASE WHEN shipping_status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered_orders,
      COALESCE(SUM(CASE WHEN shipping_status = 'returned' THEN 1 ELSE 0 END), 0) AS returned_orders,
      COALESCE(SUM(CASE WHEN payment_status IN ('paid', 'settled', 'success') THEN 1 ELSE 0 END), 0) AS paid_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'cod' THEN 1 ELSE 0 END), 0) AS cod_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'manual_transfer' THEN 1 ELSE 0 END), 0) AS manual_transfer_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'bank_transfer' THEN 1 ELSE 0 END), 0) AS virtual_account_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'qris' THEN 1 ELSE 0 END), 0) AS qris_orders,
      COALESCE(SUM(CASE WHEN payment_method NOT IN ('cod', 'manual_transfer', 'bank_transfer', 'qris') THEN 1 ELSE 0 END), 0) AS unknown_payment_orders,
      COALESCE(SUM(CASE WHEN provider_order_id IS NOT NULL OR shipping_status IN ('shipped', 'delivered', 'returned') THEN 1 ELSE 0 END), 0) AS handed_over_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'cod' AND NOT (${RELEASED_ORDER}) THEN total_amount ELSE 0 END), 0) AS cod_revenue
    FROM orders
    WHERE ${whereClause}
  `;
}

export async function readDashboardAnalytics(
  db: D1Database,
  options: {
    startDate: string | null;
    endDate: string | null;
    interval: AdminDateInterval;
    preset?: string;
    compare?: string | null;
    includeRankings?: boolean;
  },
): Promise<DashboardAnalyticsData> {
  const startParam = options.startDate || null;
  const endParam = options.endDate || null;
  const interval: AdminDateInterval =
    options.interval === "hour" && Boolean(startParam) && startParam === endParam ? "hour" : "day";

  // Sargable created_at bounds let SQLite use idx_orders_created_at while
  // keeping exact Asia/Jakarta day membership (same contract as insights-period.ts).
  const currentPeriod =
    startParam && endParam
      ? { start: startParam, end: endParam, days: daysBetweenAdminDates(startParam, endParam) + 1 }
      : null;
  const currentRange = currentPeriod ? periodClause(currentPeriod) : null;
  const currentOrderWhere = currentRange ? `${ORDER_ROW} AND ${currentRange.sql}` : ORDER_ROW;
  const currentLeadWhere = currentRange ? `${LEAD_ROW} AND ${currentRange.sql}` : LEAD_ROW;
  const currentParams = currentRange ? currentRange.params : [];

  const compareMode = isCompareMode(options.compare)
    ? options.compare
    : defaultCompareMode(options.preset || "");
  let previousRange: { start: string; end: string; cutoff: string | null } | null = null;
  if (startParam && endParam) {
    const range = compareRange(startParam, endParam, compareMode);
    previousRange = { ...range, cutoff: compareCutoff(startParam, endParam, range.start, range.end) };
  }
  const prevClause = previousRange
    ? periodClause({
        start: previousRange.start,
        end: previousRange.end,
        days: daysBetweenAdminDates(previousRange.start, previousRange.end) + 1,
      })
    : null;
  const cutoff = previousRange?.cutoff ?? null;
  const prevOrderWhere = prevClause
    ? `${ORDER_ROW} AND ${prevClause.sql}${cutoff ? " AND created_at < ?" : ""}`
    : "";
  const prevLeadWhere = prevClause
    ? `${LEAD_ROW} AND ${prevClause.sql}${cutoff ? " AND created_at < ?" : ""}`
    : "";
  const prevTrendWhere = prevClause ? `${ORDER_ROW} AND ${prevClause.sql}` : "";
  const prevCutoffParams = prevClause ? (cutoff ? [...prevClause.params, cutoff] : prevClause.params) : [];

  const groupBy =
    interval === "hour"
      ? jakartaHourBucketSql()
      : jakartaDaySql();
  const trendSelectSql = (whereClause: string) => `
    SELECT
      ${groupBy} as date,
      COALESCE(SUM(CASE WHEN ${RELEASED_ORDER} THEN 0 ELSE total_amount END), 0) as revenue,
      COUNT(*) as orders
    FROM orders
    WHERE ${whereClause}
    GROUP BY ${groupBy}
    ORDER BY date ASC
  `;

  const shouldLoadRankings = Boolean(
    options.includeRankings && currentPeriod && typeof db.batch === "function",
  );
  const rankingsPromise: Promise<DashboardRankings | null> = shouldLoadRankings && currentPeriod
    ? Promise.all([
        productRanking(db, currentPeriod, { limit: 5 }),
        landingRanking(db, currentPeriod, { limit: 5 }),
      ])
        .then(([products, pages]) => ({
          products: products.data.rows.slice(0, 5).map((row) => ({
            label: String(row.label ?? ""),
            revenue: Number(row.revenue) || 0,
            units: Number(row.units) || 0,
          })),
          pages: pages.data.rows
            .filter((row) => row.kind !== "none")
            .slice(0, 5)
            .map((row) => ({
              label: String(row.label ?? ""),
              revenue: Number(row.revenue) || 0,
              orders: Number(row.orders) || 0,
            })),
        }))
        .catch((error) => {
          console.error("dashboard-rankings", error instanceof Error ? error.message : "unknown");
          return null;
        })
    : Promise.resolve(null);

  const [row, leadRow, trendsResult, before, beforeLeads, previousTrendRows, rankings] =
    await Promise.all([
      db.prepare(summarySelectSql(currentOrderWhere)).bind(...currentParams).first() as Promise<AnalyticsRow | null>,
      db.prepare(`SELECT COUNT(*) AS leads FROM orders WHERE ${currentLeadWhere}`).bind(...currentParams).first<{ leads: number | string | null }>(),
      db.prepare(trendSelectSql(currentOrderWhere)).bind(...currentParams).all<TrendRow>(),
      prevClause
        ? (db.prepare(summarySelectSql(prevOrderWhere)).bind(...prevCutoffParams).first() as Promise<AnalyticsRow | null>)
        : Promise.resolve(null),
      prevClause
        ? db.prepare(`SELECT COUNT(*) AS leads FROM orders WHERE ${prevLeadWhere}`).bind(...prevCutoffParams).first<{ leads: number | string | null }>()
        : Promise.resolve(null),
      prevClause
        ? db.prepare(trendSelectSql(prevTrendWhere)).bind(...prevClause.params).all<TrendRow>()
        : Promise.resolve(null),
      rankingsPromise,
    ]);

  const totalOrders = Number(row?.total_orders ?? 0);
  const totalRevenue = Number(row?.total_revenue ?? 0);
  const collectedRevenue = Number(row?.collected_revenue ?? 0);
  const liveOrders = Number(row?.live_orders ?? 0);
  const onlineOrders = Number(row?.online_orders ?? 0);
  const deliveredOrders = Number(row?.delivered_orders ?? 0);
  const returnedOrders = Number(row?.returned_orders ?? 0);
  const paidOrders = Number(row?.paid_orders ?? 0);
  const codOrders = Number(row?.cod_orders ?? 0);
  const manualTransferOrders = Number(row?.manual_transfer_orders ?? 0);
  const virtualAccountOrders = Number(row?.virtual_account_orders ?? 0);
  const qrisOrders = Number(row?.qris_orders ?? 0);
  const unknownPaymentOrders = Number(row?.unknown_payment_orders ?? 0);
  const ratio = (value: number) => (totalOrders > 0 ? Number(((value / totalOrders) * 100).toFixed(2)) : 0);
  const pct = (value: number, base: number) => (base > 0 ? Number(((value / base) * 100).toFixed(2)) : 0);
  const rtsBase = deliveredOrders + returnedOrders;
  const leads = Number(leadRow?.leads ?? 0);

  let previous: DashboardAnalyticsData["previous"] = null;
  if (previousRange) {
    const beforeOnline = Number(before?.online_orders ?? 0);
    const beforeDelivered = Number(before?.delivered_orders ?? 0);
    const beforeReturned = Number(before?.returned_orders ?? 0);
    const beforeLive = Number(before?.live_orders ?? 0);
    const beforeRevenue = Number(before?.total_revenue ?? 0);
    const beforeOrders = Number(before?.total_orders ?? 0);
    const beforeLeadCount = Number(beforeLeads?.leads ?? 0);
    previous = {
      mode: compareMode,
      start_date: previousRange.start,
      end_date: previousRange.end,
      partial: Boolean(cutoff),
      total_revenue: beforeRevenue,
      live_orders: beforeLive,
      average_order_value: beforeLive > 0 ? Math.round(beforeRevenue / beforeLive) : 0,
      lead_conversion_rate: pct(beforeOrders, beforeOrders + beforeLeadCount),
      lead_base: beforeOrders + beforeLeadCount,
      conversion_rate: pct(Number(before?.paid_orders ?? 0), beforeOnline),
      online_orders: beforeOnline,
      rts_rate: pct(beforeReturned, beforeDelivered + beforeReturned),
      rts_base: beforeDelivered + beforeReturned,
      trends: buildTrends(previousTrendRows?.results ?? [], previousRange.start, previousRange.end, interval),
    };
  }

  const codRevenue = Number(row?.cod_revenue ?? 0);
  const result: DashboardAnalyticsData = {
    total_revenue: totalRevenue,
    collected_revenue: collectedRevenue,
    total_orders: totalOrders,
    live_orders: liveOrders,
    online_orders: onlineOrders,
    conversion_rate: pct(paidOrders, onlineOrders),
    rts_rate: pct(returnedOrders, rtsBase),
    rts_base: rtsBase,
    average_order_value: liveOrders > 0 ? Math.round(totalRevenue / liveOrders) : 0,
    lead_conversion_rate: pct(totalOrders, totalOrders + leads),
    lead_base: totalOrders + leads,
    cod_revenue: codRevenue,
    prepaid_revenue: totalRevenue - codRevenue,
    funnel: {
      leads,
      orders: totalOrders,
      handed_over: Number(row?.handed_over_orders ?? 0),
      delivered: deliveredOrders,
      returned: returnedOrders,
    },
    previous,
    cod_percentage: ratio(codOrders),
    transfer_percentage: ratio(virtualAccountOrders),
    qris_percentage: ratio(qrisOrders),
    payment_methods: {
      total: totalOrders,
      cod: { count: codOrders, percentage: ratio(codOrders) },
      manual_transfer: { count: manualTransferOrders, percentage: ratio(manualTransferOrders) },
      virtual_account: { count: virtualAccountOrders, percentage: ratio(virtualAccountOrders) },
      qris: { count: qrisOrders, percentage: ratio(qrisOrders) },
      unknown_count: unknownPaymentOrders,
    },
    period: {
      start_date: startParam,
      end_date: endParam,
      timezone: "Asia/Jakarta",
      basis: "order_created_at",
      interval,
    },
    trends: buildTrends(trendsResult.results ?? [], startParam, endParam, interval),
  };

  if (options.includeRankings) {
    result.rankings = rankings;
  }

  return result;
}
