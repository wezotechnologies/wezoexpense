import "server-only";

import { prisma } from "@/lib/prisma";
import { dec, percentOf, toMoneyStringOrZero } from "@/lib/money";
import { monthKeyOf, monthRangeUtc } from "@/lib/dates";
import { notifyApprovers } from "@/lib/notifications";
import { NotificationKind, TxnStatus, TxnType } from "@/generated/prisma/enums";

/**
 * Budgets and threshold alerts (spec 11).
 *
 * "Actual" counts APPROVED expenses only — a pending submission is not yet
 * money out of the door, so it must not trip a budget alert or distort the
 * budget-vs-actual report.
 */

export type BudgetLine = {
  budgetId: string | null;
  categoryId: string;
  categoryName: string;
  month: string;
  budgetInr: string;
  actualInr: string;
  remainingInr: string;
  usedPct: number;
  alertPct: number;
  breached: boolean;
  nearing: boolean;
};

/** Approved expense total for one category in one IST month. */
export async function actualForCategory(
  categoryId: string,
  month: string,
): Promise<string> {
  const range = monthRangeUtc(month);
  const result = await prisma.transaction.aggregate({
    where: {
      deletedAt: null,
      type: TxnType.EXPENSE,
      status: TxnStatus.APPROVED,
      categoryId,
      date: { gte: range.gte, lt: range.lt },
    },
    _sum: { amountInr: true },
  });
  return toMoneyStringOrZero(result._sum.amountInr ?? 0);
}

/** Every budget for a month, joined to its actual spend. */
export async function budgetLinesForMonth(month: string): Promise<BudgetLine[]> {
  const range = monthRangeUtc(month);

  const [budgets, spendByCategory] = await Promise.all([
    prisma.budget.findMany({
      where: { month },
      include: { category: { select: { id: true, name: true, isActive: true } } },
    }),
    prisma.transaction.groupBy({
      by: ["categoryId"],
      where: {
        deletedAt: null,
        type: TxnType.EXPENSE,
        status: TxnStatus.APPROVED,
        date: { gte: range.gte, lt: range.lt },
      },
      _sum: { amountInr: true },
    }),
  ]);

  const spend = new Map(
    spendByCategory
      .filter((s) => s.categoryId !== null)
      .map((s) => [s.categoryId as string, dec(s._sum.amountInr ?? 0)]),
  );

  return budgets
    .filter((b) => b.categoryId && b.category)
    .map((b) => {
      const categoryId = b.categoryId as string;
      const budget = dec(b.amountInr);
      const actual = spend.get(categoryId) ?? dec(0);
      const usedPct = percentOf(actual, budget);

      return {
        budgetId: b.id,
        categoryId,
        categoryName: b.category?.name ?? "—",
        month,
        budgetInr: toMoneyStringOrZero(budget),
        actualInr: toMoneyStringOrZero(actual),
        remainingInr: toMoneyStringOrZero(budget.minus(actual)),
        usedPct,
        alertPct: b.alertPct,
        breached: actual.greaterThan(budget),
        nearing: usedPct >= b.alertPct && !actual.greaterThan(budget),
      };
    })
    .sort((a, b) => b.usedPct - a.usedPct);
}

/**
 * Called after an expense is approved. Notifies approvers the first time a
 * category crosses its alert threshold in a month.
 *
 * De-duplication is by looking for an existing unread BUDGET_THRESHOLD
 * notification for the same category and month, which keeps the alert to one
 * per breach without needing extra schema.
 */
export async function checkBudgetThreshold(
  categoryId: string | null,
  date: Date,
): Promise<void> {
  if (!categoryId) return;

  const month = monthKeyOf(date);
  const budget = await prisma.budget.findUnique({
    where: { categoryId_month: { categoryId, month } },
    include: { category: { select: { name: true } } },
  });
  if (!budget) return;

  const budgetAmount = dec(budget.amountInr);
  if (budgetAmount.isZero()) return;

  const actual = dec(await actualForCategory(categoryId, month));
  const usedPct = percentOf(actual, budgetAmount);
  if (usedPct < budget.alertPct) return;

  const marker = `budget:${categoryId}:${month}`;
  const already = await prisma.notification.findFirst({
    where: {
      kind: NotificationKind.BUDGET_THRESHOLD,
      link: `/budgets?month=${month}`,
      body: { contains: marker },
    },
    select: { id: true },
  });
  if (already) return;

  const breached = actual.greaterThan(budgetAmount);
  const name = budget.category?.name ?? "category";

  await notifyApprovers({
    kind: NotificationKind.BUDGET_THRESHOLD,
    title: breached
      ? `${name} is over budget for ${month}`
      : `${name} has reached ${usedPct.toFixed(0)}% of its ${month} budget`,
    body: `₹${toMoneyStringOrZero(actual)} of ₹${toMoneyStringOrZero(budgetAmount)} spent. [${marker}]`,
    link: `/budgets?month=${month}`,
  });
}
