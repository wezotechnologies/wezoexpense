"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import {
  ChartEmpty,
  ChartFrame,
  ChartTooltip,
  seriesColor,
} from "@/components/charts/chart-kit";
import { formatInr, formatPercent } from "@/lib/format";

export type DonutSlice = { label: string; value: number };

/**
 * Expense split by category (spec 9.2, 10.2).
 *
 * The palette has eight validated slots and hues are never generated, so a
 * ninth category folds into "Other" rather than inventing a colour.
 *
 * The legend beside it lists every slice with its amount and share. That is
 * both the identity channel (never colour alone) and the "relief" the
 * validator requires, since some light-mode slots fall below 3:1 on white.
 */
const MAX_SLICES = 8;

export function CategoryDonut({
  slices,
  emptyMessage = "No approved expenses in this period yet.",
}: {
  slices: DonutSlice[];
  emptyMessage?: string;
}) {
  const sorted = [...slices]
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  const shown =
    sorted.length > MAX_SLICES
      ? [
          ...sorted.slice(0, MAX_SLICES - 1),
          {
            label: "Other",
            value: sorted
              .slice(MAX_SLICES - 1)
              .reduce((sum, s) => sum + s.value, 0),
          },
        ]
      : sorted;

  const total = shown.reduce((sum, s) => sum + s.value, 0);

  if (shown.length === 0) {
    return (
      <ChartFrame height={220}>
        <ChartEmpty message={emptyMessage} />
      </ChartFrame>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <ChartFrame height={190} className="w-full max-w-[190px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={shown}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="94%"
              // 2px surface gap between adjacent fills.
              paddingAngle={2}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {shown.map((slice, i) => (
                <Cell key={slice.label} fill={seriesColor(i)} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const item = payload[0];
                const value = Number(item.value ?? 0);
                return (
                  <ChartTooltip
                    title={String(item.name)}
                    rows={[
                      { label: "Amount", value: formatInr(value) },
                      {
                        label: "Share",
                        value: formatPercent(total ? (value / total) * 100 : 0),
                      },
                    ]}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </ChartFrame>

      {/* The numbers, always visible — identity and relief in one. */}
      <ul className="min-w-0 flex-1 space-y-1.5">
        {shown.map((slice, i) => (
          <li key={slice.label} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: seriesColor(i) }}
            />
            <span className="min-w-0 flex-1 truncate text-ink-muted">
              {slice.label}
            </span>
            <span className="shrink-0 font-medium tabular text-ink">
              {formatInr(slice.value)}
            </span>
            <span className="w-11 shrink-0 text-right tabular text-ink-muted/80">
              {formatPercent(total ? (slice.value / total) * 100 : 0, 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
