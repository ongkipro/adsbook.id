import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";

const fullCurrency = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
}).format;

const shortDateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatTooltipDate(raw: unknown, hourly: boolean): string {
  const text = String(raw ?? "");
  if (hourly && text.includes(":")) {
    const hour = text.split(" ")[1]?.slice(0, 5);
    return hour ? `${hour} WIB` : text;
  }
  const iso = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return shortDateFormatter.format(parsed);
  }
  return text;
}

/**
 * The dashboard's revenue chart, its own module so `AnalyticsDashboard`
 * loads it lazily: Recharts is the admin's largest chunk (330 KB, 97 KB
 * gzipped), and the KPI cards and "Action needed" paint without waiting for it.
 */
export default function DashboardRevenueChart({
  data,
  hourly,
  compareLabel,
  formatValue,
}: {
  data: Array<{ date: string; revenue: number | null; compare?: number | null }>;
  hourly: boolean;
  /** The comparison line's legend label; absent when nothing is compared. */
  compareLabel?: string;
  formatValue: (value: number) => string;
}) {
  return (
    <figure className="h-full w-full">
      <figcaption className="sr-only">
        {hourly ? "Grafik revenue kumulatif per jam dalam WIB" : "Grafik revenue harian dalam WIB"}
        {compareLabel ? `, dibandingkan ${compareLabel}` : ""}
      </figcaption>
      <ChartContainer
        config={{
          revenue: { label: "Periode ini", color: "var(--admin-accent)" },
          compare: { label: compareLabel ?? "Pembanding", color: "#94a3b8" },
        }}
        className="h-full w-full aspect-auto"
      >
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={(value) => {
              const text = String(value);
              if (text.includes(":")) return text.split(" ")[1].substring(0, 2);
              const [year, month, day] = text.slice(0, 10).split("-");
              return year && month && day ? `${Number(day)}/${Number(month)}` : text;
            }}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "#64748b" }}
            dy={8}
            minTickGap={8}
          />
          {/* 76px: "Rp1,4jt" and "Rp700rb" stay unclipped at 11px ticks. */}
          <YAxis
            width={76}
            tickFormatter={(value) => formatValue(Number(value))}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "#64748b" }}
          />
          <ChartTooltip
            cursor={{ fill: "rgba(148,163,184,0.06)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatTooltipDate(value, hourly)}
                formatter={(value, name, item) => {
                  const seriesLabel = name === "compare" ? (compareLabel ?? "Pembanding") : "Periode ini";
                  const num = Number(value);
                  return (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-slate-500">
                        <span
                          className="h-2 w-2 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: item.color }}
                          aria-hidden="true"
                        />
                        {seriesLabel}
                      </span>
                      <span className="font-semibold tabular-nums text-slate-950">
                        {Number.isFinite(num) ? fullCurrency(num) : "–"}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {hourly ? (
            <Line
              dataKey="revenue"
              type="monotone"
              stroke="var(--color-revenue)"
              strokeWidth={2.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ) : (
            <Bar
              dataKey="revenue"
              fill="var(--color-revenue)"
              radius={[5, 5, 0, 0]}
              maxBarSize={34}
              isAnimationActive={false}
            />
          )}
          {compareLabel && (
            <Line
              dataKey="compare"
              type="monotone"
              stroke="var(--color-compare)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ChartContainer>
    </figure>
  );
}
