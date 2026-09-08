import Link from "next/link";

import { Badge, cx } from "@/components/ui/primitives";
import { IconArrowDown, IconArrowUp, IconSparkle } from "@/components/icons";
import { formatDate, formatForeign, formatInr } from "@/lib/format";
import type { TransactionDTO } from "@/lib/transactions";

/** Small shared pieces for showing transactions consistently everywhere. */

export function StatusBadge({ status }: { status: string }) {
  const map = {
    PENDING: { tone: "pending", label: "Pending" },
    APPROVED: { tone: "approved", label: "Approved" },
    REJECTED: { tone: "rejected", label: "Rejected" },
  } as const;
  const entry = map[status as keyof typeof map] ?? {
    tone: "neutral" as const,
    label: status,
  };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

/**
 * Amount with direction. The arrow is the secondary encoding: income and
 * expense are never distinguished by colour alone.
 */
export function AmountCell({
  type,
  amountInr,
  className,
}: {
  type: string;
  amountInr: string;
  className?: string;
}) {
  const isIncome = type === "INCOME";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 font-medium tabular",
        isIncome ? "text-income" : "text-expense",
        className,
      )}
    >
      {isIncome ? (
        <IconArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <IconArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="sr-only">{isIncome ? "Income" : "Expense"}: </span>
      {formatInr(amountInr)}
    </span>
  );
}

/** "VAT via Dubai partner" marker — the memo, never counted as revenue. */
export function RoutingBadge({ routing }: { routing: string }) {
  if (routing !== "VIA_DUBAI_PARTNER") return null;
  return (
    <Badge tone="info" className="whitespace-nowrap">
      Via Dubai partner
    </Badge>
  );
}

export function AiBadge({
  extracted,
  confidence,
}: {
  extracted: boolean;
  confidence: number | null;
}) {
  if (!extracted) return null;
  const pct = confidence === null ? null : Math.round(confidence * 100);
  return (
    <Badge tone="accent" className="whitespace-nowrap">
      <IconSparkle className="h-3 w-3" />
      AI{pct !== null ? ` ${pct}%` : ""}
    </Badge>
  );
}

/** Compact row used on the dashboard and in drawers. */
export function TransactionRow({ txn }: { txn: TransactionDTO }) {
  const foreign = formatForeign(txn.originalAmount, txn.originalCurrency);

  return (
    <Link
      href={`/transactions?id=${txn.id}`}
      className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {txn.vendorName ?? txn.categoryName ?? (txn.type === "INCOME" ? "Income" : "Expense")}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
          <span>{formatDate(txn.date)}</span>
          {txn.categoryName ? <span>· {txn.categoryName}</span> : null}
          {txn.paymentLabel ? <span>· {txn.paymentLabel}</span> : null}
          {foreign ? <span>· {foreign}</span> : null}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <AmountCell type={txn.type} amountInr={txn.amountInr} className="text-sm" />
        <StatusBadge status={txn.status} />
      </div>
    </Link>
  );
}
