"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Select,
  Spinner,
  cx,
} from "@/components/ui/primitives";
import { IconTarget, IconTrash } from "@/components/icons";
import { formatInr, formatMonthKey, formatPercent } from "@/lib/format";
import type { BudgetLine } from "@/lib/budgets";

/** Budgets with actual-vs-budget and threshold alerts (spec 9.9, 11). */
export function BudgetsManager({
  month,
  lines,
  categories,
}: {
  month: string;
  lines: BudgetLine[];
  categories: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [alertPct, setAlertPct] = useState("80");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budgeted = lines.reduce((sum, l) => sum + Number(l.budgetInr), 0);
  const actual = lines.reduce((sum, l) => sum + Number(l.actualInr), 0);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/budgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categoryId,
          month,
          amountInr: amount,
          alertPct: Number(alertPct),
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not save that budget.");
        return;
      }

      setCategoryId("");
      setAmount("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch("/api/budgets", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
      <Card>
        <CardHeader
          title="Set a budget"
          description={`For ${formatMonthKey(month)}`}
        />
        <form onSubmit={save} className="space-y-3 p-4">
          {error ? <Alert tone="error">{error}</Alert> : null}

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Expense category
            </span>
            <Select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              required
            >
              <option value="">Choose…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Monthly limit (INR)
            </span>
            <Input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular"
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Alert at
            </span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={200}
                value={alertPct}
                onChange={(e) => setAlertPct(e.target.value)}
                className="tabular"
              />
              <span className="text-sm text-ink-muted">% of the limit</span>
            </div>
          </label>

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={busy || !categoryId || !amount}
          >
            {busy ? <Spinner /> : null}
            Save budget
          </Button>

          <p className="text-[11px] text-ink-muted">
            Setting a budget for a category that already has one replaces it.
            Approvers are notified once spending crosses the alert threshold.
          </p>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Budget vs actual"
          description={`${formatInr(actual.toFixed(2))} spent of ${formatInr(budgeted.toFixed(2))} budgeted`}
        />

        {lines.length === 0 ? (
          <EmptyState
            icon={<IconTarget className="h-7 w-7" />}
            title="No budgets for this month"
            description="Set a limit on an expense category to track it here and get an alert before it runs out."
          />
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((line) => (
              <li key={line.categoryId} className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {line.categoryName}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-muted tabular">
                      {formatInr(line.actualInr)} of {formatInr(line.budgetInr)} ·{" "}
                      {Number(line.remainingInr) < 0
                        ? `${formatInr(String(Math.abs(Number(line.remainingInr))))} over`
                        : `${formatInr(line.remainingInr)} left`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      tone={
                        line.breached ? "rejected" : line.nearing ? "pending" : "approved"
                      }
                    >
                      {formatPercent(line.usedPct, 0)}
                    </Badge>
                    {line.budgetId ? (
                      <button
                        type="button"
                        aria-label={`Remove the ${line.categoryName} budget`}
                        onClick={() => remove(line.budgetId!)}
                        disabled={busy}
                        className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-2 hover:text-expense"
                      >
                        <IconTrash className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Bar carries a label as well as colour, never colour alone. */}
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                  role="img"
                  aria-label={`${formatPercent(line.usedPct, 0)} of the ${line.categoryName} budget used`}
                >
                  <div
                    className={cx(
                      "h-full rounded-full transition-all",
                      line.breached
                        ? "bg-expense"
                        : line.nearing
                          ? "bg-pending"
                          : "bg-income",
                    )}
                    style={{ width: `${Math.min(100, line.usedPct)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
