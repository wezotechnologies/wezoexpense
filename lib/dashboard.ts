import "server-only";

import { prisma } from "@/lib/prisma";
import { isAdminPlus, transactionScope, type SessionUser } from "@/lib/rbac";
import { dec, toMoneyStringOrZero } from "@/lib/money";
import {
  addMonths,
  currentMonthKey,
  monthKeyOf,
  monthKeysBetween,
  monthRangeUtc,
} from "@/lib/dates";
import { budgetLinesForMonth, type BudgetLine } from "@/lib/budgets";
import { formatMonthShort } from "@/lib/format";
import { listInclude, serializeTransaction, type TransactionDTO } from "@/lib/transactions";
import { TxnStatus, TxnType } from "@/generated/prisma/enums";

/**
 * Dashboard data (spec 9.2).
 *
 * Admin/Superadmin see the whole company. An Employee sees only their own
 * submissions and statuses — enforced by `transactionScope`, the same
 * where-fragment the API uses, so the two can't drift apart.
 */

export type DashboardData = {
  scope: "company" | "personal";
  month: string;
  kpis: {
    income: string;
    expense: string;
    net: string;
    pendingCount: number;
    myPending: number;
    myApproved: number;
    myRejected: number;
  };
  flow: Array<{ label: string; income: number; expense: number }>;
  flowTotals: { income: string; expense: string };
  categories: Array<{ label: string; value: number }>;
  recent: TransactionDTO[];
  budgetAlerts: BudgetLine[];
};

const MONTHS_ON_CHART = 6;

export async function getDashboard(user: SessionUser): Promise<DashboardData> {
  const company = isAdminPlus(user);
  const month = currentMonthKey();
  const monthRange = monthRangeUtc(month);

  const scopeWhere = transactionScope(user);

  // Approved-only for money figures: a pending submission is not yet cash.
  const monthWhere = {
    ...scopeWhere,
    status: TxnStatus.APPROVED,
    date: { gte: monthRange.gte, lt: monthRange.lt },
  };

  const chartFrom = addMonths(month, -(MONTHS_ON_CHART - 1));
  const chartRange = {
    gte: monthRangeUtc(chartFrom).gte,
    lt: monthRange.lt,
  };

  const [
    monthTotals,
    pendingCount,
    myCounts,
    flowRows,
    categoryRows,
    recentRows,
    budgetLines,
  ] = await Promise.all([
    prisma.transaction.groupBy({
      by: ["type"],
      where: monthWhere,
      _sum: { amountInr: true },
    }),
    company
      ? prisma.transaction.count({
          where: { deletedAt: null, status: TxnStatus.PENDING },
        })
      : Promise.resolve(0),
    prisma.transaction.groupBy({
      by: ["status"],
      where: { deletedAt: null, createdById: user.id },
      _count: true,
    }),
    prisma.transaction.findMany({
      where: {
        ...scopeWhere,
        status: TxnStatus.APPROVED,
        date: chartRange,
      },
      select: { date: true, type: true, amountInr: true },
    }),
    prisma.transaction.groupBy({
      by: ["categoryId"],
      where: { ...monthWhere, type: TxnType.EXPENSE },
      _sum: { amountInr: true },
    }),
    prisma.transaction.findMany({
      where: scopeWhere,
      include: listInclude,
      orderBy: [{ createdAt: "desc" }],
      take: 8,
    }),
    company ? budgetLinesForMonth(month) : Promise.resolve([]),
  ]);

  const income = dec(
    monthTotals.find((t) => t.type === TxnType.INCOME)?._sum.amountInr ?? 0,
  );
  const expense = dec(
    monthTotals.find((t) => t.type === TxnType.EXPENSE)?._sum.amountInr ?? 0,
  );

  // Bucket the flow series by IST month.
  const months = monthKeysBetween(chartFrom, month);
  const buckets = new Map(months.map((m) => [m, { income: 0, expense: 0 }]));
  for (const row of flowRows) {
    const key = monthKeyOf(row.date);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const amount = Number(dec(row.amountInr).toFixed(2));
    if (row.type === TxnType.INCOME) bucket.income += amount;
    else bucket.expense += amount;
  }

  const flow = months.map((m) => ({
    label: formatMonthShort(m),
    income: buckets.get(m)?.income ?? 0,
    expense: buckets.get(m)?.expense ?? 0,
  }));

  const categoryIds = categoryRows
    .map((r) => r.categoryId)
    .filter((id): id is string => !!id);
  const categoryNames = new Map(
    (
      await prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );

  const categories = categoryRows
    .map((r) => ({
      label: r.categoryId
        ? (categoryNames.get(r.categoryId) ?? "Uncategorised")
        : "Uncategorised",
      value: Number(dec(r._sum.amountInr ?? 0).toFixed(2)),
    }))
    .filter((c) => c.value > 0);

  const statusCount = (status: TxnStatus) =>
    myCounts.find((c) => c.status === status)?._count ?? 0;

  return {
    scope: company ? "company" : "personal",
    month,
    kpis: {
      income: toMoneyStringOrZero(income),
      expense: toMoneyStringOrZero(expense),
      net: toMoneyStringOrZero(income.minus(expense)),
      pendingCount,
      myPending: statusCount(TxnStatus.PENDING),
      myApproved: statusCount(TxnStatus.APPROVED),
      myRejected: statusCount(TxnStatus.REJECTED),
    },
    flow,
    flowTotals: {
      income: flow.reduce((a, f) => a + f.income, 0).toFixed(2),
      expense: flow.reduce((a, f) => a + f.expense, 0).toFixed(2),
    },
    categories,
    recent: recentRows.map(serializeTransaction),
    budgetAlerts: budgetLines.filter((b) => b.nearing || b.breached),
  };
}
