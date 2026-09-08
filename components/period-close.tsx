"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Spinner,
} from "@/components/ui/primitives";
import { IconLock, IconUnlock } from "@/components/icons";
import { formatDateTime, formatInr, formatMonthKey } from "@/lib/format";
import type { PeriodSummary } from "@/lib/periods";

/**
 * Monthly close (spec 7.5, 9.14).
 *
 * Closing seals a month against edits. Only a Superadmin can reopen one, and
 * both actions are logged — that is the point of the feature.
 */
export function PeriodClose({
  periods,
  canUnlock,
}: {
  periods: PeriodSummary[];
  canUnlock: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(month: string, action: "lock" | "unlock") {
    setBusy(month);
    setError(null);
    try {
      const response = await fetch(`/api/periods/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "That action could not be completed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Recent months"
        description="Closing a month stops anyone editing transactions dated in it."
      />

      {error ? (
        <div className="border-b border-line p-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      <ul className="divide-y divide-line">
        {periods.map((period) => (
          <li
            key={period.month}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {formatMonthKey(period.month)}
                {period.locked ? (
                  <Badge tone="neutral">
                    <IconLock className="h-3 w-3" />
                    Closed
                  </Badge>
                ) : null}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                {period.transactionCount} transaction
                {period.transactionCount === 1 ? "" : "s"} ·{" "}
                <span className="text-income">{formatInr(period.incomeInr)}</span> in ·{" "}
                <span className="text-expense">{formatInr(period.expenseInr)}</span> out
                {period.locked && period.lockedAt
                  ? ` · closed ${formatDateTime(period.lockedAt)}${period.lockedByName ? ` by ${period.lockedByName}` : ""}`
                  : ""}
              </p>
              {period.pendingCount > 0 && !period.locked ? (
                <p className="mt-1 text-[11px] text-pending">
                  {period.pendingCount} submission
                  {period.pendingCount === 1 ? "" : "s"} still awaiting approval —
                  clear the queue before closing.
                </p>
              ) : null}
            </div>

            <div className="shrink-0">
              {period.locked ? (
                canUnlock ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === period.month}
                    onClick={() => {
                      if (
                        confirm(
                          `Reopen ${formatMonthKey(period.month)}? Transactions in it become editable again. This is recorded in the audit log.`,
                        )
                      ) {
                        void act(period.month, "unlock");
                      }
                    }}
                  >
                    {busy === period.month ? <Spinner /> : <IconUnlock className="h-3.5 w-3.5" />}
                    Reopen
                  </Button>
                ) : (
                  <span className="text-[11px] text-ink-muted">
                    Only a Superadmin can reopen
                  </span>
                )
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === period.month || period.pendingCount > 0}
                  onClick={() => {
                    if (
                      confirm(
                        `Close ${formatMonthKey(period.month)}? Transactions dated in it can no longer be edited.`,
                      )
                    ) {
                      void act(period.month, "lock");
                    }
                  }}
                >
                  {busy === period.month ? <Spinner /> : <IconLock className="h-3.5 w-3.5" />}
                  Close month
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
