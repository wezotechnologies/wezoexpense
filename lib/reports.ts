import "server-only";

import { prisma } from "@/lib/prisma";
import { isAdminPlus, type SessionUser } from "@/lib/rbac";
import { dec, percentOf, toMoneyStringOrZero } from "@/lib/money";
import {
  currentMonthKey,
  dayRangeUtc,
  monthEndDateKey,
  monthKeyOf,
  monthKeysBetween,
  monthStartDateKey,
} from "@/lib/dates";
import { budgetLinesForMonth } from "@/lib/budgets";
import { formatDate, formatMonthKey } from "@/lib/format";
import { TxnStatus, TxnType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { ReportQuery } from "@/lib/validation";

/**
 * Reporting engine (spec 10).
 *
 * Every report is reduced to the same `Report` shape — summary tiles, tables,
 * and memo lines — so one CSV writer and one PDF writer serve all seven. Adding
 * a report means adding a builder, not another exporter.
 *
 * Two rules hold across all of them:
 *
 *  1. Reports read `amountInr` and nothing else. Original currency appears only
 *     as a reference column (spec 5.1).
 *  2. VAT collected via the Dubai partner is never revenue. It is surfaced as a
 *     memo line computed from `vatAmount`, while the booked income stays the net
 *     `amountInr` (spec 5.4).
 *
 * Financial reports are cash-basis over APPROVED transactions: a pending
 * submission is not yet money that moved. The basis is printed on every export
 * so a reader never has to guess.
 */

export type ReportType =
  | "pnl"
  | "expenses-by-category"
  | "expenses-by-vendor"
  | "income-summary"
  | "cash-flow"
  | "budget-vs-actual"
  | "user-submissions";

export type ColumnKind = "text" | "money" | "percent" | "int" | "date";

export type ReportColumn = {
  key: string;
  label: string;
  kind?: ColumnKind;
};

export type ReportRow = Record<string, string | number | null>;

export type ReportTable = {
  title?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Rendered as a bold final row. */
  total?: ReportRow;
  emptyMessage?: string;
};

export type SummaryTile = {
  label: string;
  value: string;
  /** Counts must not be money-formatted — "2 payments", never "2.00". */
  kind?: "money" | "count";
  tone?: "income" | "expense" | "neutral" | "positive" | "negative";
  hint?: string;
};

export type Report = {
  type: ReportType;
  title: string;
  periodLabel: string;
  basisNote: string;
  generatedAt: string;
  generatedByName: string;
  filterNotes: string[];
  summary: SummaryTile[];
  tables: ReportTable[];
  memos: string[];
  /** Simple series for the on-screen chart; exports ignore it. */
  chart?: {
    kind: "bar" | "donut" | "line";
    data: Array<{ label: string; value: number; value2?: number }>;
  };
};

export const REPORT_TITLES: Record<ReportType, string> = {
  pnl: "Profit & Loss",
  "expenses-by-category": "Expenses by Category",
  "expenses-by-vendor": "Expenses by Vendor / Payee",
  "income-summary": "Income Summary",
  "cash-flow": "Cash Flow",
  "budget-vs-actual": "Budget vs Actual",
  "user-submissions": "Submissions by User",
};

// ---------------------------------------------------------------------------
// Range resolution
// ---------------------------------------------------------------------------

export type ResolvedRange = {
  from: string;
  to: string;
  gte: Date;
  lt: Date;
  label: string;
};

/** Resolves from/to/month into a concrete IST day range, defaulting to this month. */
export function resolveRange(query: ReportQuery): ResolvedRange {
  if (query.month) {
    const from = monthStartDateKey(query.month);
    const to = monthEndDateKey(query.month);
    const { gte, lt } = dayRangeUtc(from, to);
    return { from, to, gte, lt, label: formatMonthKey(query.month) };
  }

  const month = currentMonthKey();
  const from = query.from ?? monthStartDateKey(month);
  const to = query.to ?? monthEndDateKey(month);
  const { gte, lt } = dayRangeUtc(from, to);

  // A whole calendar month reads better as "September 2026".
  const isWholeMonth =
    from === monthStartDateKey(from.slice(0, 7)) &&
    to === monthEndDateKey(from.slice(0, 7)) &&
    from.slice(0, 7) === to.slice(0, 7);

  return {
    from,
    to,
    gte,
    lt,
    label: isWholeMonth
      ? formatMonthKey(from.slice(0, 7))
      : `${formatDate(gte)} — ${formatDate(new Date(lt.getTime() - 1))}`,
  };
}

/**
 * Base where-clause for a report. Employees are scoped to their own rows so
 * the per-user summary they are allowed to see cannot leak anyone else's.
 */
function baseWhere(
  user: SessionUser,
  query: ReportQuery,
  range: ResolvedRange,
): Prisma.TransactionWhereInput {
  return {
    deletedAt: null,
    status: query.status ?? TxnStatus.APPROVED,
    date: { gte: range.gte, lt: range.lt },
    ...(isAdminPlus(user) ? {} : { createdById: user.id }),
    ...(query.createdById && isAdminPlus(user)
      ? { createdById: query.createdById }
      : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
  };
}

function basisNoteFor(query: ReportQuery): string {
  const status = query.status ?? TxnStatus.APPROVED;
  return status === TxnStatus.APPROVED
    ? "Cash basis. Approved transactions only. All figures in INR."
    : `Cash basis. ${status.charAt(0)}${status.slice(1).toLowerCase()} transactions only. All figures in INR.`;
}

async function describeFilters(query: ReportQuery): Promise<string[]> {
  const notes: string[] = [];
  if (query.categoryId) {
    const c = await prisma.category.findUnique({
      where: { id: query.categoryId },
      select: { name: true },
    });
    if (c) notes.push(`Category: ${c.name}`);
  }
  if (query.vendorId) {
    const v = await prisma.vendor.findUnique({
      where: { id: query.vendorId },
      select: { name: true },
    });
    if (v) notes.push(`Vendor/Client: ${v.name}`);
  }
  if (query.projectId) {
    const p = await prisma.project.findUnique({
      where: { id: query.projectId },
      select: { name: true },
    });
    if (p) notes.push(`Project: ${p.name}`);
  }
  if (query.createdById) {
    const u = await prisma.user.findUnique({
      where: { id: query.createdById },
      select: { name: true },
    });
    if (u) notes.push(`Submitted by: ${u.name}`);
  }
  return notes;
}

/**
 * VAT handled by the Dubai partner in the period. Reported as a memo only —
 * it is explicitly NOT Wezo India income (spec 5.4).
 */
async function vatMemoLines(
  where: Prisma.TransactionWhereInput,
): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where: {
      ...where,
      type: TxnType.INCOME,
      routing: "VIA_DUBAI_PARTNER",
      vatAmount: { not: null },
    },
    select: { vatAmount: true, vatCurrency: true },
  });

  if (rows.length === 0) return [];

  const byCurrency = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    const code = r.vatCurrency ?? "AED";
    byCurrency.set(code, (byCurrency.get(code) ?? dec(0)).plus(dec(r.vatAmount ?? 0)));
  }

  const parts = [...byCurrency.entries()]
    .map(([code, total]) => `${code} ${total.toFixed(2)}`)
    .join(", ");

  return [
    `VAT handled via Dubai partner: ${parts} across ${rows.length} payment${rows.length === 1 ? "" : "s"}. Excluded from revenue and P&L — the partner collects and remits this VAT, and Wezo India books only the net amount received.`,
  ];
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

async function buildPnl(
  user: SessionUser,
  query: ReportQuery,
  range: ResolvedRange,
): Promise<Omit<Report, "type" | "title" | "generatedAt" | "generatedByName">> {
  const where = baseWhere(user, query, range);

  const [incomeByCategory, expenseByCategory, memos] = await Promise.all([
    prisma.transaction.groupBy({
      by: ["categoryId"],
      where: { ...where, type: TxnType.INCOME },
      _sum: { amountInr: true },
      _count: true,
    }),
    prisma.transaction.groupBy({
      by: ["categoryId"],
      where: { ...where, type: TxnType.EXPENSE },
      _sum: { amountInr: true },
      _count: true,
    }),
    vatMemoLines(where),
  ]);

  const names = await categoryNames([
    ...incomeByCategory.map((r) => r.categoryId),
    ...expenseByCategory.map((r) => r.categoryId),
  ]);

  const incomeTotal = incomeByCategory.reduce(
    (acc, r) => acc.plus(dec(r._sum.amountInr ?? 0)),
    dec(0),
  );
  const expenseTotal = expenseByCategory.reduce(
    (acc, r) => acc.plus(dec(r._sum.amountInr ?? 0)),
    dec(0),
  );
  const net = incomeTotal.minus(expenseTotal);

  const incomeRows = incomeByCategory
    .map((r) => ({
      category: names.get(r.categoryId ?? "") ?? "Uncategorised",
      count: r._count,
      amount: toMoneyStringOrZero(r._sum.amountInr ?? 0),
      share: percentOf(r._sum.amountInr ?? 0, incomeTotal),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  const expenseRows = expenseByCategory
    .map((r) => ({
      category: names.get(r.categoryId ?? "") ?? "Uncategorised",
      count: r._count,
      amount: toMoneyStringOrZero(r._sum.amountInr ?? 0),
      share: percentOf(r._sum.amountInr ?? 0, expenseTotal),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  const columns: ReportColumn[] = [
    { key: "category", label: "Category" },
    { key: "count", label: "Txns", kind: "int" },
    { key: "amount", label: "Amount (INR)", kind: "money" },
    { key: "share", label: "% of total", kind: "percent" },
  ];

  return {
    periodLabel: range.label,
    basisNote: basisNoteFor(query),
    filterNotes: await describeFilters(query),
    summary: [
      { label: "Income", value: toMoneyStringOrZero(incomeTotal), tone: "income" },
      { label: "Expenses", value: toMoneyStringOrZero(expenseTotal), tone: "expense" },
      {
        label: net.isNegative() ? "Net loss" : "Net profit",
        value: toMoneyStringOrZero(net),
        tone: net.isNegative() ? "negative" : "positive",
      },
    ],
    tables: [
      {
        title: "Income",
        columns,
        rows: incomeRows,
        total: {
          category: "Total income",
          count: incomeRows.reduce((a, r) => a + r.count, 0),
          amount: toMoneyStringOrZero(incomeTotal),
          share: 100,
        },
        emptyMessage: "No income recorded in this period.",
      },
      {
        title: "Expenses",
        columns,
        rows: expenseRows,
        total: {
          category: "Total expenses",
          count: expenseRows.reduce((a, r) => a + r.count, 0),
          amount: toMoneyStringOrZero(expenseTotal),
          share: 100,
        },
        emptyMessage: "No expenses recorded in this period.",
      },
      {
        title: "Result",
        columns: [
          { key: "line", label: "Line" },
          { key: "amount", label: "Amount (INR)", kind: "money" },
        ],
        rows: [
          { line: "Total income", amount: toMoneyStringOrZero(incomeTotal) },
          { line: "Total expenses", amount: toMoneyStringOrZero(expenseTotal) },
        ],
        total: {
          line: net.isNegative() ? "Net loss" : "Net profit",
          amount: toMoneyStringOrZero(net),
        },
      },
    ],
    memos,
    chart: {
      kind: "bar",
      data: [
        { label: "Income", value: Number(toMoneyStringOrZero(incomeTotal)) },
        { label: "Expenses", value: Number(toMoneyStringOrZero(expenseTotal)) },
      ],
    },
  };
}

async function categoryNames(
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.category.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function buildGroupedTotals(
  user: SessionUser,
  query: ReportQuery,
  range: ResolvedRange,
  opts: {
    type: TxnType;
    groupBy: "categoryId" | "vendorId";
    groupLabel: string;
    unlabelled: string;
  },
): Promise<Omit<Report, "type" | "title" | "generatedAt" | "generatedByName">> {
  const where = { ...baseWhere(user, query, range), type: opts.type };

  const grouped = await prisma.transaction.groupBy({
    by: [opts.groupBy],
    where,
    _sum: { amountInr: true },
    _count: true,
  });

  const ids = grouped
    .map((g) => (opts.groupBy === "categoryId" ? g.categoryId : g.vendorId))
    .filter((i): i is string => !!i);

  const names =
    opts.groupBy === "categoryId"
      ? await categoryNames(ids)
      : new Map(
          (
            await prisma.vendor.findMany({
              where: { id: { in: [...new Set(ids)] } },
              select: { id: true, name: true },
            })
          ).map((v) => [v.id, v.name]),
        );

  const total = grouped.reduce(
    (acc, g) => acc.plus(dec(g._sum.amountInr ?? 0)),
    dec(0),
  );

  const rows = grouped
    .map((g) => {
      const id = opts.groupBy === "categoryId" ? g.categoryId : g.vendorId;
      return {
        group: id ? (names.get(id) ?? opts.unlabelled) : opts.unlabelled,
        count: g._count,
        amount: toMoneyStringOrZero(g._sum.amountInr ?? 0),
        share: percentOf(g._sum.amountInr ?? 0, total),
      };
    })
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  return {
    periodLabel: range.label,
    basisNote: basisNoteFor(query),
    filterNotes: await describeFilters(query),
    summary: [
      {
        label: opts.type === TxnType.EXPENSE ? "Total expenses" : "Total income",
        value: toMoneyStringOrZero(total),
        tone: opts.type === TxnType.EXPENSE ? "expense" : "income",
      },
      { label: opts.groupLabel + "s", value: String(rows.length), kind: "count", tone: "neutral" },
      {
        label: "Transactions",
        value: String(rows.reduce((a, r) => a + r.count, 0)),
        kind: "count",
        tone: "neutral",
      },
    ],
    tables: [
      {
        columns: [
          { key: "group", label: opts.groupLabel },
          { key: "count", label: "Txns", kind: "int" },
          { key: "amount", label: "Amount (INR)", kind: "money" },
          { key: "share", label: "% of total", kind: "percent" },
        ],
        rows,
        total: {
          group: "Total",
          count: rows.reduce((a, r) => a + r.count, 0),
          amount: toMoneyStringOrZero(total),
          share: 100,
        },
        emptyMessage: "Nothing recorded in this period.",
      },
    ],
    memos: [],
    chart: {
      kind: "donut",
      data: rows.slice(0, 8).map((r) => ({
        label: r.group,
        value: Number(r.amount),
      })),
    },
  };
}

/** Income by client, with payment labels and an original-currency memo column. */
async function buildIncomeSummary(
  user: SessionUser,
  query: ReportQuery,
  range: ResolvedRange,
): Promise<Omit<Report, "type" | "title" | "generatedAt" | "generatedByName">> {
  const where = { ...baseWhere(user, query, range), type: TxnType.INCOME };

  const [rows, memos] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: [{ date: "asc" }],
      include: {
        vendor: { select: { name: true } },
        project: { select: { name: true } },
        category: { select: { name: true } },
      },
    }),
    vatMemoLines(where),
  ]);

  const total = rows.reduce((acc, r) => acc.plus(dec(r.amountInr)), dec(0));

  // Per-client roll-up
  const byClient = new Map<
    string,
    { amount: Prisma.Decimal; count: number; labels: string[] }
  >();
  for (const r of rows) {
    const key = r.vendor?.name ?? "Unattributed";
    const entry = byClient.get(key) ?? { amount: dec(0), count: 0, labels: [] };
    entry.amount = entry.amount.plus(dec(r.amountInr));
    entry.count += 1;
    if (r.paymentLabel && !entry.labels.includes(r.paymentLabel)) {
      entry.labels.push(r.paymentLabel);
    }
    byClient.set(key, entry);
  }

  const clientRows = [...byClient.entries()]
    .map(([client, v]) => ({
      client,
      count: v.count,
      labels: v.labels.join(", ") || "—",
      amount: toMoneyStringOrZero(v.amount),
      share: percentOf(v.amount, total),
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  const detailRows = rows.map((r) => ({
    date: r.date.toISOString(),
    client: r.vendor?.name ?? "—",
    project: r.project?.name ?? "—",
    label: r.paymentLabel ?? "—",
    category: r.category?.name ?? "—",
    routing: r.routing === "VIA_DUBAI_PARTNER" ? "Via Dubai partner" : "Direct",
    original:
      r.originalAmount && r.originalCurrency
        ? `${r.originalCurrency} ${dec(r.originalAmount).toFixed(2)}`
        : "—",
    amount: toMoneyStringOrZero(r.amountInr),
  }));

  return {
    periodLabel: range.label,
    basisNote: basisNoteFor(query),
    filterNotes: await describeFilters(query),
    summary: [
      { label: "Total income", value: toMoneyStringOrZero(total), tone: "income" },
      { label: "Clients", value: String(clientRows.length), kind: "count", tone: "neutral" },
      { label: "Payments", value: String(rows.length), kind: "count", tone: "neutral" },
    ],
    tables: [
      {
        title: "By client",
        columns: [
          { key: "client", label: "Client" },
          { key: "count", label: "Payments", kind: "int" },
          { key: "labels", label: "Payment labels" },
          { key: "amount", label: "Received (INR)", kind: "money" },
          { key: "share", label: "% of total", kind: "percent" },
        ],
        rows: clientRows,
        total: {
          client: "Total",
          count: rows.length,
          labels: "",
          amount: toMoneyStringOrZero(total),
          share: 100,
        },
        emptyMessage: "No income recorded in this period.",
      },
      {
        title: "Payments received",
        columns: [
          { key: "date", label: "Date", kind: "date" },
          { key: "client", label: "Client" },
          { key: "project", label: "Project" },
          { key: "label", label: "Payment" },
          { key: "category", label: "Category" },
          { key: "routing", label: "Routing" },
          { key: "original", label: "Original (memo)" },
          { key: "amount", label: "Booked (INR)", kind: "money" },
        ],
        rows: detailRows,
        total: {
          date: "",
          client: "Total",
          project: "",
          label: "",
          category: "",
          routing: "",
          original: "",
          amount: toMoneyStringOrZero(total),
        },
        emptyMessage: "No income recorded in this period.",
      },
    ],
    memos,
    chart: {
      kind: "donut",
      data: clientRows.slice(0, 8).map((r) => ({
        label: r.client,
        value: Number(r.amount),
      })),
    },
  };
}

/** Money in vs out, bucketed by IST month. */
async function buildCashFlow(
  user: SessionUser,
  query: ReportQuery,
  range: ResolvedRange,
): Promise<Omit<Report, "type" | "title" | "generatedAt" | "generatedByName">> {
  const where = baseWhere(user, query, range);

  const rows = await prisma.transaction.findMany({
    where,
    select: { date: true, type: true, amountInr: true },
  });

  const months = monthKeysBetween(range.from.slice(0, 7), range.to.slice(0, 7));
  const buckets = new Map<
    string,
    { income: Prisma.Decimal; expense: Prisma.Decimal }
  >(months.map((m) => [m, { income: dec(0), expense: dec(0) }]));

  for (const r of rows) {
    const key = monthKeyOf(r.date);
    const bucket = buckets.get(key) ?? { income: dec(0), expense: dec(0) };
    if (r.type === TxnType.INCOME) {
      bucket.income = bucket.income.plus(dec(r.amountInr));
    } else {
      bucket.expense = bucket.expense.plus(dec(r.amountInr));
    }
    buckets.set(key, bucket);
  }

  let running = dec(0);
  const tableRows = [...buckets.entries()].map(([month, v]) => {
    const net = v.income.minus(v.expense);
    running = running.plus(net);
    return {
      month: formatMonthKey(month),
      monthKey: month,
      income: toMoneyStringOrZero(v.income),
      expense: toMoneyStringOrZero(v.expense),
      net: toMoneyStringOrZero(net),
      running: toMoneyStringOrZero(running),
    };
  });

  const totalIn = [...buckets.values()].reduce((a, v) => a.plus(v.income), dec(0));
  const totalOut = [...buckets.values()].reduce((a, v) => a.plus(v.expense), dec(0));

  return {
    periodLabel: range.label,
    basisNote: basisNoteFor(query),
    filterNotes: await describeFilters(query),
    summary: [
      { label: "Money in", value: toMoneyStringOrZero(totalIn), tone: "income" },
      { label: "Money out", value: toMoneyStringOrZero(totalOut), tone: "expense" },
      {
        label: "Net movement",
        value: toMoneyStringOrZero(totalIn.minus(totalOut)),
        tone: totalIn.minus(totalOut).isNegative() ? "negative" : "positive",
      },
    ],
    tables: [
      {
        columns: [
          { key: "month", label: "Month" },
          { key: "income", label: "Money in (INR)", kind: "money" },
          { key: "expense", label: "Money out (INR)", kind: "money" },
          { key: "net", label: "Net (INR)", kind: "money" },
          { key: "running", label: "Cumulative (INR)", kind: "money" },
        ],
        // monthKey is kept on tableRows for the chart; the table shows the label.
        rows: tableRows.map((r) => ({
          month: r.month,
          income: r.income,
          expense: r.expense,
          net: r.net,
          running: r.running,
        })),
        total: {
          month: "Total",
          income: toMoneyStringOrZero(totalIn),
          expense: toMoneyStringOrZero(totalOut),
          net: toMoneyStringOrZero(totalIn.minus(totalOut)),
          running: toMoneyStringOrZero(running),
        },
        emptyMessage: "Nothing recorded in this period.",
      },
    ],
    memos: await vatMemoLines(where),
    chart: {
      kind: "line",
      data: tableRows.map((r) => ({
        label: r.month,
        value: Number(r.income),
        value2: Number(r.expense),
      })),
    },
  };
}

async function buildBudgetVsActual(
  query: ReportQuery,
  range: ResolvedRange,
): Promise<Omit<Report, "type" | "title" | "generatedAt" | "generatedByName">> {
  const month = query.month ?? range.from.slice(0, 7);
  const lines = await budgetLinesForMonth(month);

  const budgetTotal = lines.reduce((a, l) => a.plus(dec(l.budgetInr)), dec(0));
  const actualTotal = lines.reduce((a, l) => a.plus(dec(l.actualInr)), dec(0));

  return {
    periodLabel: formatMonthKey(month),
    basisNote:
      "Approved expenses only. A pending submission is not yet money out, so it does not count against a budget.",
    filterNotes: [],
    summary: [
      { label: "Budgeted", value: toMoneyStringOrZero(budgetTotal), tone: "neutral" },
      { label: "Actual", value: toMoneyStringOrZero(actualTotal), tone: "expense" },
      {
        label: "Remaining",
        value: toMoneyStringOrZero(budgetTotal.minus(actualTotal)),
        tone: budgetTotal.minus(actualTotal).isNegative() ? "negative" : "positive",
      },
    ],
    tables: [
      {
        columns: [
          { key: "category", label: "Category" },
          { key: "budget", label: "Budget (INR)", kind: "money" },
          { key: "actual", label: "Actual (INR)", kind: "money" },
          { key: "remaining", label: "Remaining (INR)", kind: "money" },
          { key: "used", label: "Used", kind: "percent" },
          { key: "state", label: "Status" },
        ],
        rows: lines.map((l) => ({
          category: l.categoryName,
          budget: l.budgetInr,
          actual: l.actualInr,
          remaining: l.remainingInr,
          used: l.usedPct,
          state: l.breached ? "Over budget" : l.nearing ? "Near limit" : "On track",
        })),
        total: {
          category: "Total",
          budget: toMoneyStringOrZero(budgetTotal),
          actual: toMoneyStringOrZero(actualTotal),
          remaining: toMoneyStringOrZero(budgetTotal.minus(actualTotal)),
          used: percentOf(actualTotal, budgetTotal),
          state: "",
        },
        emptyMessage: "No budgets set for this month.",
      },
    ],
    memos: [],
    chart: {
      kind: "bar",
      data: lines.map((l) => ({
        label: l.categoryName,
        value: Number(l.actualInr),
        value2: Number(l.budgetInr),
      })),
    },
  };
}

/** What each user submitted (spec 10.7). Employees see only their own line. */
async function buildUserSubmissions(
  user: SessionUser,
  query: ReportQuery,
  range: ResolvedRange,
): Promise<Omit<Report, "type" | "title" | "generatedAt" | "generatedByName">> {
  const where = baseWhere(user, query, {
    ...range,
  });

  // This report is about submission activity, so it counts every status
  // rather than approved-only — unless the caller asked for one.
  const activityWhere: Prisma.TransactionWhereInput = {
    ...where,
    ...(query.status ? { status: query.status } : { status: undefined }),
  };

  const grouped = await prisma.transaction.groupBy({
    by: ["createdById", "type", "status"],
    where: activityWhere,
    _sum: { amountInr: true },
    _count: true,
  });

  const userIds = [...new Set(grouped.map((g) => g.createdById))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true, role: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  type Agg = {
    name: string;
    role: string;
    income: Prisma.Decimal;
    expense: Prisma.Decimal;
    pending: number;
    approved: number;
    rejected: number;
    count: number;
  };

  const byUser = new Map<string, Agg>();
  for (const g of grouped) {
    const u = userMap.get(g.createdById);
    const entry =
      byUser.get(g.createdById) ??
      ({
        name: u?.name ?? "—",
        role: u?.role ?? "—",
        income: dec(0),
        expense: dec(0),
        pending: 0,
        approved: 0,
        rejected: 0,
        count: 0,
      } satisfies Agg);

    const amount = dec(g._sum.amountInr ?? 0);
    if (g.type === TxnType.INCOME) entry.income = entry.income.plus(amount);
    else entry.expense = entry.expense.plus(amount);

    if (g.status === TxnStatus.PENDING) entry.pending += g._count;
    if (g.status === TxnStatus.APPROVED) entry.approved += g._count;
    if (g.status === TxnStatus.REJECTED) entry.rejected += g._count;
    entry.count += g._count;

    byUser.set(g.createdById, entry);
  }

  const rows = [...byUser.values()]
    .map((v) => ({
      name: v.name,
      role: v.role.charAt(0) + v.role.slice(1).toLowerCase(),
      count: v.count,
      income: toMoneyStringOrZero(v.income),
      expense: toMoneyStringOrZero(v.expense),
      pending: v.pending,
      approved: v.approved,
      rejected: v.rejected,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    periodLabel: range.label,
    basisNote: query.status
      ? basisNoteFor(query)
      : "All submissions regardless of status. All figures in INR.",
    filterNotes: await describeFilters(query),
    summary: [
      { label: "People", value: String(rows.length), kind: "count", tone: "neutral" },
      {
        label: "Submissions",
        value: String(rows.reduce((a, r) => a + r.count, 0)),
        kind: "count",
        tone: "neutral",
      },
      {
        label: "Awaiting approval",
        value: String(rows.reduce((a, r) => a + r.pending, 0)),
        kind: "count",
        tone: "neutral",
      },
    ],
    tables: [
      {
        columns: [
          { key: "name", label: "User" },
          { key: "role", label: "Role" },
          { key: "count", label: "Submissions", kind: "int" },
          { key: "income", label: "Income (INR)", kind: "money" },
          { key: "expense", label: "Expenses (INR)", kind: "money" },
          { key: "approved", label: "Approved", kind: "int" },
          { key: "pending", label: "Pending", kind: "int" },
          { key: "rejected", label: "Rejected", kind: "int" },
        ],
        rows,
        emptyMessage: "No submissions in this period.",
      },
    ],
    memos: [],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function buildReport(
  user: SessionUser,
  type: ReportType,
  query: ReportQuery,
): Promise<Report> {
  const range = resolveRange(query);

  const body = await (async () => {
    switch (type) {
      case "pnl":
        return buildPnl(user, query, range);
      case "expenses-by-category":
        return buildGroupedTotals(user, query, range, {
          type: TxnType.EXPENSE,
          groupBy: "categoryId",
          groupLabel: "Category",
          unlabelled: "Uncategorised",
        });
      case "expenses-by-vendor":
        return buildGroupedTotals(user, query, range, {
          type: TxnType.EXPENSE,
          groupBy: "vendorId",
          groupLabel: "Vendor / Payee",
          unlabelled: "Unattributed",
        });
      case "income-summary":
        return buildIncomeSummary(user, query, range);
      case "cash-flow":
        return buildCashFlow(user, query, range);
      case "budget-vs-actual":
        return buildBudgetVsActual(query, range);
      case "user-submissions":
        return buildUserSubmissions(user, query, range);
    }
  })();

  return {
    type,
    title: REPORT_TITLES[type],
    generatedAt: new Date().toISOString(),
    generatedByName: user.name,
    ...body,
  };
}
