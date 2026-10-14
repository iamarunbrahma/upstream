"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { IndexRow } from "@/lib/index/usage";

const config = {
  work: { label: "Share of agent work", color: "var(--chart-2)" },
  money: { label: "Share of money set aside", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** The "Agent Usage vs Funding" chart: per package, its share of agent work against its share of the money. */
export function UsageChart(props: { rows: IndexRow[] }) {
  const data = props.rows.map((r) => ({ name: r.name, work: r.usageBp / 100, money: r.fundingBp / 100 }));
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(220, data.length * 52 + 60) }}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 44 }} barGap={4} barCategoryGap={16}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={104} tick={{ fontSize: 13 }} />
        <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent formatter={(value, name) => `${config[name as keyof typeof config].label}: ${Number(value).toFixed(1)}%`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="work" fill="var(--color-work)" radius={[0, 6, 6, 0]} barSize={12}>
          <LabelList dataKey="work" position="right" className="fill-muted-foreground" fontSize={11} formatter={(v: unknown) => `${Number(v).toFixed(1)}%`} />
        </Bar>
        <Bar dataKey="money" fill="var(--color-money)" radius={[0, 6, 6, 0]} barSize={12}>
          <LabelList dataKey="money" position="right" className="fill-muted-foreground" fontSize={11} formatter={(v: unknown) => `${Number(v).toFixed(1)}%`} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
