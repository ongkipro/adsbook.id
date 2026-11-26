import { Line, LineChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '../ui/chart';
import { insightsMoney, insightsNumber } from '../../lib/insights-view';

const compactRupiah = (value: number) => {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `Rp${m.toLocaleString('id-ID', { maximumFractionDigits: m < 10 ? 1 : 0 })}jt`;
  }
  if (value >= 1_000) return `Rp${Math.round(value / 1_000)}rb`;
  return `Rp${Math.round(value)}`;
};

export default function InsightsChart({ series, metric }: {
  series: Array<{ date: string; orders: number; leads: number; revenue: number; meta_purchases: number }>;
  metric: 'orders' | 'leads' | 'revenue' | 'meta_purchases';
}) {
  const label = { orders: 'Orders', leads: 'Leads', revenue: 'Revenue', meta_purchases: 'Purchase ke Meta' }[metric];
  return (
    <figure className="w-full">
      <figcaption className="sr-only">Grafik tren {label} harian dalam WIB</figcaption>
      <ChartContainer config={{ [metric]: { label, color: 'var(--chart-1)' } }} className="h-64 w-full">
        <LineChart data={series} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey="date" tickFormatter={(date: string) => date.slice(5)} minTickGap={30} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
          <YAxis width={76} domain={[0, 'auto']} tickFormatter={(value: number) => metric === 'revenue' ? compactRupiah(value) : insightsNumber(value)} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} />
          <ChartTooltip content={<ChartTooltipContent formatter={(value) => metric === 'revenue' ? insightsMoney(Number(value)) : insightsNumber(Number(value))} />} />
          <Line dataKey={metric} name={label} type="linear" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </figure>
  );
}
