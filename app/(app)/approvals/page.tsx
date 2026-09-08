import type { Metadata } from "next";

import { ApprovalCard } from "@/components/approval-card";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { IconCheck } from "@/components/icons";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/rbac";
import { listInclude, serializeTransaction } from "@/lib/transactions";
import { formatInr } from "@/lib/format";
import { dec, toMoneyStringOrZero } from "@/lib/money";
import { TxnStatus, TxnType } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Pending approvals" };

export default async function ApprovalsPage() {
  const user = await requireCapability("approve");

  const rows = await prisma.transaction.findMany({
    where: { status: TxnStatus.PENDING, deletedAt: null },
    include: listInclude,
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    take: 100,
  });

  const items = rows.map(serializeTransaction);

  const incomeTotal = items
    .filter((t) => t.type === TxnType.INCOME)
    .reduce((sum, t) => sum.plus(dec(t.amountInr)), dec(0));
  const expenseTotal = items
    .filter((t) => t.type === TxnType.EXPENSE)
    .reduce((sum, t) => sum.plus(dec(t.amountInr)), dec(0));

  return (
    <>
      <PageHeader
        title="Pending approvals"
        description={
          items.length === 0
            ? "Nothing is waiting for review."
            : `${items.length} submission${items.length === 1 ? "" : "s"} awaiting your review. Check each against its receipt before approving.`
        }
      />

      {items.length > 0 ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile label="Awaiting review" value={String(items.length)} />
          <Tile
            label="Income pending"
            value={formatInr(toMoneyStringOrZero(incomeTotal))}
            tone="income"
          />
          <Tile
            label="Expenses pending"
            value={formatInr(toMoneyStringOrZero(expenseTotal))}
            tone="expense"
          />
        </div>
      ) : null}

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconCheck className="h-7 w-7" />}
            title="The queue is clear"
            description="New submissions from Employees will appear here, and approvers get a notification."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((txn) => (
            <ApprovalCard
              key={txn.id}
              txn={txn}
              isOwn={txn.createdById === user.id}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "income" | "expense";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <p className="text-[11px] text-ink-muted">{label}</p>
      <p
        className={`mt-0.5 text-sm font-semibold tabular sm:text-base ${
          tone === "income" ? "text-income" : tone === "expense" ? "text-expense" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
