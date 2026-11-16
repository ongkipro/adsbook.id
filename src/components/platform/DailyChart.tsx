import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";

/**
 * UX-7: new stores (bars) and paid invoices (line) per WIB day — the seller
 * dashboard's ChartContainer and Recharts, loaded as its own island.
 */
export default function DailyChart({ points }: { points: { day: string; signups: number; paid: number }[] }) {
  return (
    <ChartContainer
      config={{ signups: { label: "Toko baru", color: "var(--admin-accent)" }, paid: { label: "Dibayar", color: "#d55e00" } }}
      className="h-56 w-full"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickFormatter={(value) => { const [, month, day] = String(value).split("-"); return `${Number(day)}/${Number(month)}`; }}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: "#64748b" }}
            dy={8}
            minTickGap={12}
          />
          <YAxis allowDecimals={false} width={40} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#64748b" }} />
          <ChartTooltip cursor={{ fill: "rgba(148,163,184,0.06)" }} content={<ChartTooltipContent />} />
          <Bar dataKey="signups" fill="var(--color-signups)" radius={[5, 5, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          <Line
            dataKey="paid"
            type="monotone"
            stroke="var(--color-paid)"
            strokeWidth={2}
            isAnimationActive={false}
            // A marker only on a day with a payment: thirty dots on zero read as noise.
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: { paid: number } }) =>
              props.payload && props.payload.paid > 0 ? <circle key={props.index} cx={props.cx} cy={props.cy} r={3.5} fill="#fff" stroke="var(--color-paid)" strokeWidth={2} /> : <g key={props.index} />}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}
