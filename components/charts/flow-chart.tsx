"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartEmpty,
  ChartFrame,
  ChartLegend,
  ChartTooltip,
  FLOW_IN,
  FLOW_OUT,
} from "@/components/charts/chart-kit";
import { formatInr, formatInrShort } from "@/lib/format";

export type FlowPoint = {
  label: string;
  income: number;
  expense: number;
};

/**
 * Money in vs money out over time (spec 9.2).
 *
 * Grouped bars on ONE axis — both series are INR, so a second scale would be a
 * lie. The money-in/money-out hues sit in the 6-8 CVD band, so the secondary
 * encoding the validator requires is built in: the two bars are separated by a
 * gap and by position within each group, a legend with totals is always shown,
 * and the tooltip names each series in text.
 */
export function FlowChart({
  data,
  totals,
}: {
  data: FlowPoint[];
  totals?: { income: string; expense: string };
}) {
  const hasData = data.some((d) => d.income > 0 || d.expense > 0);

  return (
    <div>
      <ChartLegend
        className="mb-3 px-1"
        entries={[
          { label: "Money in", color: FLOW_IN, value: totals?.income ? formatInr(totals.income) : undefined },
          { label: "Money out", color: FLOW_OUT, value: totals?.expense ? formatInr(totals.expense) : undefined },
        ]}
      />

      <ChartFrame height={230}>
        {!hasData ? (
          <ChartEmpty message="No approved transactions in this period yet." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 4, right: 4, bottom: 0, left: -12 }}
              barGap={2}
              barCategoryGap="22%"
            >
              {/* Recessive grid: horizontal only, no vertical clutter. */}
              <CartesianGrid
                stroke="var(--grid)"
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => formatInrShort(v)}
              />
              <Tooltip
                cursor={{ fill: "var(--surface-2)", opacity: 0.6 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <ChartTooltip
                      title={String(label)}
                      rows={[
                        {
                          label: "Money in",
                          color: FLOW_IN,
                          value: formatInr(Number(payload[0]?.value ?? 0)),
                        },
                        {
                          label: "Money out",
                          color: FLOW_OUT,
                          value: formatInr(Number(payload[1]?.value ?? 0)),
                        },
                      ]}
                    />
                  );
                }}
              />
              {/* 4px rounded data-ends, anchored to the baseline. */}
              <Bar dataKey="income" fill={FLOW_IN} radius={[4, 4, 0, 0]} maxBarSize={26} />
              <Bar dataKey="expense" fill={FLOW_OUT} radius={[4, 4, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartFrame>
    </div>
  );
}
