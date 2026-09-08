"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  Alert,
  Card,
  CardHeader,
  Input,
  LinkButton,
  Select,
  cx,
} from "@/components/ui/primitives";
import { IconDownload, IconFile } from "@/components/icons";
import { CategoryDonut } from "@/components/charts/category-donut";
import { FlowChart } from "@/components/charts/flow-chart";
import { formatDate, formatInr, formatPercent } from "@/lib/format";
import type { Report, ReportColumn, ReportRow } from "@/lib/reports";

/**
 * Report viewer (spec 9.7, 10).
 *
 * Reads a `Report` — the same shape the PDF and CSV writers consume — so what
 * is on screen and what is exported cannot disagree. Range and report choice
 * live in the URL, so an export link is simply the current view plus a format.
 */

export const REPORT_OPTIONS = [
  { value: "pnl", label: "Profit & Loss" },
  { value: "expenses-by-category", label: "Expenses by category" },
  { value: "expenses-by-vendor", label: "Expenses by vendor" },
  { value: "income-summary", label: "Income summary" },
  { value: "cash-flow", label: "Cash flow" },
  { value: "budget-vs-actual", label: "Budget vs actual" },
  { value: "user-submissions", label: "Submissions by user" },
] as const;

export function ReportControls({
  type,
  from,
  to,
  month,
  allowedTypes,
}: {
  type: string;
  from: string;
  to: string;
  month: string;
  allowedTypes: readonly string[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  function go(patch: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.push(`/reports?${next.toString()}`);
  }

  const monthly = type === "budget-vs-actual";

  return (
    <Card className="mb-4 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1">
          <span className="block text-[11px] font-medium text-ink-muted">Report</span>
          <Select value={type} onChange={(e) => go({ type: e.target.value })}>
            {REPORT_OPTIONS.filter((o) => allowedTypes.includes(o.value)).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>

        {monthly ? (
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Month</span>
            <Input
              type="month"
              value={month}
              onChange={(e) => go({ month: e.target.value, from: "", to: "" })}
            />
          </label>
        ) : (
          <>
            <label className="space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">From</span>
              <Input
                type="date"
                value={from}
                onChange={(e) => go({ from: e.target.value, month: "" })}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">To</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => go({ to: e.target.value, month: "" })}
              />
            </label>
          </>
        )}

        <div className="flex items-end">
          <PresetPicker onPick={(patch) => go(patch)} />
        </div>
      </div>
    </Card>
  );
}

/** Quick ranges, including the Indian financial year (April to March). */
function PresetPicker({
  onPick,
}: {
  onPick: (patch: Record<string, string>) => void;
}) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const pad = (n: number) => String(n).padStart(2, "0");

  // FY runs 1 Apr - 31 Mar; before April we are still in the previous FY.
  const fyStartYear = m >= 4 ? y : y - 1;

  const presets: Array<{ label: string; patch: Record<string, string> }> = [
    {
      label: "This month",
      patch: { month: "", from: `${y}-${pad(m)}-01`, to: lastDay(y, m) },
    },
    {
      label: "Last month",
      patch: (() => {
        const pm = m === 1 ? 12 : m - 1;
        const py = m === 1 ? y - 1 : y;
        return { month: "", from: `${py}-${pad(pm)}-01`, to: lastDay(py, pm) };
      })(),
    },
    {
      label: "This quarter",
      patch: (() => {
        const qStart = Math.floor((m - 1) / 3) * 3 + 1;
        return {
          month: "",
          from: `${y}-${pad(qStart)}-01`,
          to: lastDay(y, qStart + 2),
        };
      })(),
    },
    {
      label: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`,
      patch: {
        month: "",
        from: `${fyStartYear}-04-01`,
        to: `${fyStartYear + 1}-03-31`,
      },
    },
  ];

  return (
    <label className="w-full space-y-1">
      <span className="block text-[11px] font-medium text-ink-muted">Quick range</span>
      <Select
        defaultValue=""
        onChange={(e) => {
          const preset = presets.find((p) => p.label === e.target.value);
          if (preset) onPick(preset.patch);
        }}
      >
        <option value="">Choose…</option>
        {presets.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

function lastDay(year: number, month: number): string {
  const normalisedYear = year + Math.floor((month - 1) / 12);
  const normalisedMonth = ((month - 1) % 12) + 1;
  const day = new Date(Date.UTC(normalisedYear, normalisedMonth, 0)).getUTCDate();
  return `${normalisedYear}-${String(normalisedMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function ReportBody({
  report,
  exportQuery,
}: {
  report: Report;
  exportQuery: string;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={report.title}
          description={`${report.periodLabel} · ${report.basisNote}`}
          action={
            <div className="flex gap-2">
              <LinkButton
                href={`/api/reports/${report.type}/export?${exportQuery}&fmt=csv`}
                variant="secondary"
                size="sm"
              >
                <IconDownload className="h-3.5 w-3.5" />
                CSV
              </LinkButton>
              <LinkButton
                href={`/api/reports/${report.type}/export?${exportQuery}&fmt=pdf`}
                variant="primary"
                size="sm"
              >
                <IconFile className="h-3.5 w-3.5" />
                PDF
              </LinkButton>
            </div>
          }
        />

        {report.filterNotes.length > 0 ? (
          <p className="border-b border-line px-4 py-2 text-[11px] text-ink-muted">
            {report.filterNotes.join(" · ")}
          </p>
        ) : null}

        <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {report.summary.map((tile) => (
            <div key={tile.label} className="px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                {tile.label}
              </p>
              <p
                className={cx(
                  "mt-1 text-lg font-semibold tabular sm:text-xl",
                  tile.tone === "income" && "text-income",
                  tile.tone === "expense" && "text-expense",
                  tile.tone === "negative" && "text-expense",
                  tile.tone === "positive" && "text-income",
                )}
              >
                {tile.kind === "count" ? tile.value : formatInr(tile.value)}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {report.memos.length > 0 ? (
        <Alert tone="info" title="Notes">
          <ul className="space-y-1">
            {report.memos.map((memo) => (
              <li key={memo}>{memo}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {report.chart ? <ReportChart report={report} /> : null}

      {report.tables.map((table, index) => (
        <Card key={table.title ?? index} className="overflow-hidden">
          {table.title ? <CardHeader title={table.title} /> : null}

          {table.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              {table.emptyMessage ?? "No data for this period."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-wide text-ink-muted">
                    {table.columns.map((column) => (
                      <th
                        key={column.key}
                        className={cx(
                          "px-4 py-2.5 font-medium",
                          isNumeric(column) ? "text-right" : "text-left",
                        )}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {table.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-surface-2">
                      {table.columns.map((column) => (
                        <td
                          key={column.key}
                          className={cx(
                            "px-4 py-2.5",
                            isNumeric(column) ? "text-right tabular" : "",
                          )}
                        >
                          {renderCell(row, column)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {table.total ? (
                  <tfoot>
                    <tr className="border-t border-line bg-surface-2/60 font-semibold">
                      {table.columns.map((column) => (
                        <td
                          key={column.key}
                          className={cx(
                            "px-4 py-2.5",
                            isNumeric(column) ? "text-right tabular" : "",
                          )}
                        >
                          {renderCell(table.total!, column)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          )}
        </Card>
      ))}

      <p className="text-center text-[11px] text-ink-muted">
        Generated {formatDate(report.generatedAt)} by {report.generatedByName} ·{" "}
        <Link href="/transactions" className="text-accent hover:underline">
          see the underlying transactions
        </Link>
      </p>
    </div>
  );
}

function ReportChart({ report }: { report: Report }) {
  const chart = report.chart!;

  if (chart.kind === "donut") {
    return (
      <Card>
        <CardHeader title="Breakdown" />
        <div className="p-4 sm:p-5">
          <CategoryDonut
            slices={chart.data.map((d) => ({ label: d.label, value: d.value }))}
            emptyMessage="Nothing to chart for this period."
          />
        </div>
      </Card>
    );
  }

  // Both bar and line forms compare two same-scale INR series, so one axis and
  // the money-in/money-out encoding apply to both.
  const isBudget = report.type === "budget-vs-actual";

  return (
    <Card>
      <CardHeader title={isBudget ? "Actual vs budget" : "Money in vs money out"} />
      <div className="p-4 sm:p-5">
        <FlowChart
          data={chart.data.map((d) => ({
            label: d.label,
            income: isBudget ? (d.value2 ?? 0) : d.value,
            expense: isBudget ? d.value : (d.value2 ?? 0),
          }))}
        />
        {isBudget ? (
          <p className="mt-2 text-[11px] text-ink-muted">
            The first bar in each pair is the budget; the second is what was actually
            spent.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function isNumeric(column: ReportColumn): boolean {
  return (
    column.kind === "money" || column.kind === "percent" || column.kind === "int"
  );
}

function renderCell(row: ReportRow, column: ReportColumn): string {
  const raw = row[column.key];
  if (raw === null || raw === undefined || raw === "") return "—";
  switch (column.kind) {
    case "money":
      return formatInr(String(raw));
    case "percent":
      return formatPercent(Number(raw), 1);
    case "date":
      return formatDate(String(raw));
    default:
      return String(raw);
  }
}
