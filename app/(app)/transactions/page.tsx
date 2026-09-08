import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";

import {
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  cx,
} from "@/components/ui/primitives";
import { IconDownload, IconPlus } from "@/components/icons";
import {
  AiBadge,
  AmountCell,
  RoutingBadge,
  StatusBadge,
} from "@/components/txn-bits";
import { TxnDetailDrawer } from "@/components/txn-detail-drawer";
import { TxnFilters } from "@/components/txn-filters";
import { prisma } from "@/lib/prisma";
import { formatDate, formatForeign, formatInr } from "@/lib/format";
import { isAdminPlus, requireUser } from "@/lib/rbac";
import { listTransactions } from "@/lib/transactions";
import { transactionFilterSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage(
  props: PageProps<"/transactions">,
) {
  const user = await requireUser();
  const searchParams = await props.searchParams;

  // Unknown or malformed params fall back to defaults rather than erroring.
  const parsed = transactionFilterSchema.safeParse(searchParams);
  const filter = parsed.success ? parsed.data : transactionFilterSchema.parse({});

  const [result, categories, vendors, users] = await Promise.all([
    listTransactions(user, filter),
    prisma.category.findMany({
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    prisma.vendor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    isAdminPlus(user)
      ? prisma.user.findMany({
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const query = new URLSearchParams(
    Object.entries(searchParams).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v] as [string, string]] : [],
    ),
  );
  query.delete("page");
  query.delete("id");

  const totalPages = Math.max(1, Math.ceil(result.total / result.perPage));

  return (
    <>
      <PageHeader
        title="Transactions"
        description={
          isAdminPlus(user)
            ? "Every recorded income and expense."
            : "Everything you've submitted."
        }
        action={
          <div className="flex gap-2">
            <LinkButton
              href={`/api/transactions/export?${query.toString()}`}
              variant="secondary"
            >
              <IconDownload className="h-4 w-4" />
              Export CSV
            </LinkButton>
            <LinkButton href="/add" variant="primary">
              <IconPlus className="h-4 w-4" />
              Add
            </LinkButton>
          </div>
        }
      />

      <Suspense fallback={null}>
        <TxnFilters
          options={{
            categories,
            vendors,
            users,
            canSeeAllUsers: isAdminPlus(user),
          }}
        />
      </Suspense>

      {/* Totals for the whole filter, not just this page */}
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Total label="Income" value={formatInr(result.totals.income)} tone="income" />
        <Total label="Expenses" value={formatInr(result.totals.expense)} tone="expense" />
        <Total
          label="Net"
          value={formatInr(result.totals.net)}
          tone={result.totals.net.startsWith("-") ? "expense" : "neutral"}
        />
      </div>

      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState
            title="No transactions match"
            description="Try widening the filters, or record your first transaction."
            action={
              <LinkButton href="/add" variant="primary" size="sm">
                <IconPlus className="h-4 w-4" />
                Add transaction
              </LinkButton>
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Description</th>
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    <th className="px-4 py-2.5 font-medium">Submitted by</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((txn) => {
                    const foreign = formatForeign(
                      txn.originalAmount,
                      txn.originalCurrency,
                    );
                    return (
                      <tr key={txn.id} className="transition-colors hover:bg-surface-2">
                        <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">
                          <Link href={rowHref(query, txn.id)} scroll={false}>
                            {formatDate(txn.date)}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          <Link href={rowHref(query, txn.id)} scroll={false} className="block">
                            <span className="font-medium">
                              {txn.vendorName ??
                                txn.notes?.slice(0, 40) ??
                                (txn.type === "INCOME" ? "Income" : "Expense")}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              {txn.paymentLabel ? (
                                <span className="text-[11px] text-ink-muted">
                                  {txn.paymentLabel}
                                </span>
                              ) : null}
                              {foreign ? (
                                <span className="text-[11px] text-ink-muted">{foreign}</span>
                              ) : null}
                              <RoutingBadge routing={txn.routing} />
                              <AiBadge
                                extracted={txn.aiExtracted}
                                confidence={txn.aiConfidence}
                              />
                            </span>
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-ink-muted">
                          <Link href={rowHref(query, txn.id)} scroll={false}>
                            {txn.categoryName ?? "—"}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-ink-muted">
                          <Link href={rowHref(query, txn.id)} scroll={false}>
                            {txn.createdByName}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <Link href={rowHref(query, txn.id)} scroll={false}>
                            <AmountCell type={txn.type} amountInr={txn.amountInr} />
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          <Link href={rowHref(query, txn.id)} scroll={false}>
                            <StatusBadge status={txn.status} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <ul className="divide-y divide-line lg:hidden">
              {result.rows.map((txn) => {
                const foreign = formatForeign(txn.originalAmount, txn.originalCurrency);
                return (
                  <li key={txn.id}>
                    <Link
                      href={rowHref(query, txn.id)}
                      scroll={false}
                      className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {txn.vendorName ??
                            txn.categoryName ??
                            (txn.type === "INCOME" ? "Income" : "Expense")}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
                          <span>{formatDate(txn.date)}</span>
                          {txn.categoryName ? <span>· {txn.categoryName}</span> : null}
                          {foreign ? <span>· {foreign}</span> : null}
                        </p>
                        <span className="mt-1 flex flex-wrap gap-1">
                          <RoutingBadge routing={txn.routing} />
                          <AiBadge extracted={txn.aiExtracted} confidence={txn.aiConfidence} />
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <AmountCell type={txn.type} amountInr={txn.amountInr} />
                        <StatusBadge status={txn.status} />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      {totalPages > 1 ? (
        <nav
          className="mt-4 flex items-center justify-between gap-3"
          aria-label="Pagination"
        >
          <p className="text-xs text-ink-muted">
            Page {result.page} of {totalPages} · {result.total} transactions
          </p>
          <div className="flex gap-2">
            <PageLink query={query} page={result.page - 1} disabled={result.page <= 1}>
              Previous
            </PageLink>
            <PageLink
              query={query}
              page={result.page + 1}
              disabled={result.page >= totalPages}
            >
              Next
            </PageLink>
          </div>
        </nav>
      ) : null}

      <Suspense fallback={null}>
        <TxnDetailDrawer
          canApprove={isAdminPlus(user)}
          canDelete={isAdminPlus(user)}
          currentUserId={user.id}
        />
      </Suspense>
    </>
  );
}

function rowHref(query: URLSearchParams, id: string): string {
  const next = new URLSearchParams(query.toString());
  next.set("id", id);
  return `/transactions?${next.toString()}`;
}

function PageLink({
  query,
  page,
  disabled,
  children,
}: {
  query: URLSearchParams;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-muted/40">
        {children}
      </span>
    );
  }
  const next = new URLSearchParams(query.toString());
  next.set("page", String(page));
  return (
    <Link
      href={`/transactions?${next.toString()}`}
      className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-muted hover:border-ink-muted/50 hover:text-ink"
    >
      {children}
    </Link>
  );
}

function Total({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "income" | "expense" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <p className="text-[11px] text-ink-muted">{label}</p>
      <p
        className={cx(
          "mt-0.5 text-sm font-semibold tabular sm:text-base",
          tone === "income" && "text-income",
          tone === "expense" && "text-expense",
        )}
      >
        {value}
      </p>
    </div>
  );
}
