"use client";

import type { ReactNode } from "react";

import { cx } from "@/components/ui/primitives";
import { formatInr } from "@/lib/format";

/**
 * Shared chart furniture.
 *
 * Two rules from the data-viz pass are enforced here rather than left to each
 * chart:
 *
 *  1. Identity is never colour alone. `ChartLegend` pairs every swatch with its
 *     label *and* its value, which doubles as the "relief" required because
 *     several palette slots fall below 3:1 on the light surface.
 *  2. Text wears text tokens, never the series colour — the swatch carries
 *     identity, the label stays in ink.
 */

export const SERIES_VARS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
] as const;

export const FLOW_IN = "var(--flow-in)";
export const FLOW_OUT = "var(--flow-out)";

/** Palette has 8 slots; anything beyond folds into "Other" before it gets here. */
export function seriesColor(index: number): string {
  return SERIES_VARS[index % SERIES_VARS.length];
}

export function ChartFrame({
  children,
  height = 240,
  className,
}: {
  children: ReactNode;
  height?: number;
  className?: string;
}) {
  return (
    <div className={cx("w-full", className)} style={{ height }}>
      {children}
    </div>
  );
}

export type LegendEntry = {
  label: string;
  color: string;
  value?: string;
  hint?: string;
};

/** Always rendered for two or more series. Carries the numbers, not just hues. */
export function ChartLegend({
  entries,
  className,
}: {
  entries: LegendEntry[];
  className?: string;
}) {
  return (
    <ul className={cx("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-xs">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: entry.color }}
          />
          <span className="text-ink-muted">{entry.label}</span>
          {entry.value ? (
            <span className="font-medium tabular text-ink">{entry.value}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Tooltip shell shared by every chart, so hover looks the same everywhere. */
export function ChartTooltip({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string; color?: string }>;
}) {
  return (
    <div className="pointer-events-none rounded-lg border border-line bg-surface px-2.5 py-2 shadow-lg shadow-black/30">
      <p className="mb-1 text-[11px] font-semibold text-ink">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center gap-2 text-[11px] text-ink-muted"
          >
            {row.color ? (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ background: row.color }}
              />
            ) : null}
            <span>{row.label}</span>
            <span className="ml-auto font-medium tabular text-ink">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="text-xs text-ink-muted">{message}</p>
    </div>
  );
}

export const moneyTooltip = (value: number) => formatInr(value);
