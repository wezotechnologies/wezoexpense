import Link from "next/link";
import type { Metadata } from "next";

import { CategoryDonut } from "@/components/charts/category-donut";
import { FlowChart } from "@/components/charts/flow-chart";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
  cx,
} from "@/components/ui/primitives";
import { IconPlus } from "@/components/icons";
import { TransactionRow } from "@/components/txn-bits";
import { getDashboard } from "@/lib/dashboard";
import { formatInr, formatMonthKey, formatPercent } from "@/lib/format";
import { requireUser } from "@/lib/rbac";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();
  const data = await getDashboard(user);
  const company = data.scope === "company";

  return (
    <>
      <PageHeader
        title={company ? "Dashboard" : `Hello, ${user.name.split(" ")[0]}`}
        description={
          company
            ? `Company books for ${formatMonthKey(data.month)}. Figures are approved transactions in INR.`
            : `Your submissions for ${formatMonthKey(data.month)}.`
        }
        action={
          <LinkButton href="/add" variant="primary">
            <IconPlus className="h-4 w-4" />
            Add transaction
          </LinkButton>
        }
      />

      {/* KPI tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Income this month" value={formatInr(data.kpis.income)} tone="income" />
        <Kpi label="Expenses this month" value={formatInr(data.kpis.expense)} tone="expense" />
        <Kpi
          label="Net"
          value={formatInr(data.kpis.net)}
          tone={data.kpis.net.startsWith("-") ? "expense" : "neutral"}
        />
        {company ? (
          <Kpi
            label="Awaiting approval"
            value={String(data.kpis.pendingCount)}
            tone={data.kpis.pendingCount > 0 ? "pending" : "neutral"}
            href="/approvals"
          />
        ) : (
          <Kpi
            label="Your pending"
            value={String(data.kpis.myPending)}
            tone={data.kpis.myPending > 0 ? "pending" : "neutral"}
            href="/transactions?status=PENDING"
          />
        )}
      </div>

      {/* Budget alerts */}
      {data.budgetAlerts.length > 0 ? (
        <Card className="mb-4 border-pending/30">
          <CardHeader
            title="Budget alerts"
            description={`${formatMonthKey(data.month)}`}
            action={
              <Link href="/budgets" className="text-xs text-accent hover:underline">
                Manage budgets
              </Link>
            }
          />
          <ul className="divide-y divide-line">
            {data.budgetAlerts.map((line) => (
              <li
                key={line.categoryId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
              >
                <span className="font-medium">{line.categoryName}</span>
                <Badge tone={line.breached ? "rejected" : "pending"}>
                  {line.breached ? "Over budget" : `${formatPercent(line.usedPct, 0)} used`}
                </Badge>
                <span className="ml-auto text-xs tabular text-ink-muted">
                  {formatInr(line.actualInr)} of {formatInr(line.budgetInr)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Money in vs money out"
            description="Approved transactions over the last six months, in INR."
          />
          <div className="p-4 sm:p-5">
            <FlowChart data={data.flow} totals={data.flowTotals} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Where the money went"
            description={`Expenses by category, ${formatMonthKey(data.month)}`}
          />
          <div className="p-4 sm:p-5">
            <CategoryDonut slices={data.categories} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={company ? "Recent activity" : "Your recent submissions"}
            action={
              <Link href="/transactions" className="text-xs text-accent hover:underline">
                View all
              </Link>
            }
          />
          {data.recent.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              description="Upload a receipt or enter a transaction to get started."
              action={
                <LinkButton href="/add" variant="primary" size="sm">
                  <IconPlus className="h-4 w-4" />
                  Add transaction
                </LinkButton>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.recent.map((txn) => (
                <li key={txn.id}>
                  <TransactionRow txn={txn} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {!company ? (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Kpi label="Approved" value={String(data.kpis.myApproved)} tone="income" />
          <Kpi label="Pending" value={String(data.kpis.myPending)} tone="pending" />
          <Kpi label="Rejected" value={String(data.kpis.myRejected)} tone="expense" />
        </div>
      ) : null}
    </>
  );
}

function Kpi({
  label,
  value,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string;
  tone?: "income" | "expense" | "pending" | "neutral";
  href?: string;
}) {
  const toneClass = {
    income: "text-income",
    expense: "text-expense",
    pending: "text-pending",
    neutral: "text-ink",
  }[tone];

  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </p>
      <p className={cx("mt-1.5 text-xl font-semibold tabular sm:text-2xl", toneClass)}>
        {value}
      </p>
    </>
  );

  const className =
    "rounded-lg border border-line bg-surface px-4 py-3 transition-colors";

  return href ? (
    <Link href={href} className={cx(className, "hover:border-ink-muted/40")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
