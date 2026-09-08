import Link from "next/link";
import type { Metadata } from "next";

import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
} from "@/components/ui/primitives";
import { IconBriefcase, IconPlus } from "@/components/icons";
import { prisma } from "@/lib/prisma";
import { dec, toMoneyStringOrZero } from "@/lib/money";
import { formatDate, formatForeign, formatInr, formatPercent } from "@/lib/format";
import { requireCapability } from "@/lib/rbac";
import { TxnStatus, TxnType, VendorKind } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Clients & payments" };

/**
 * Per-client ledger (spec 5.3, 9.6).
 *
 * Answers "Client X has paid 1st and 2nd payment; 3rd pending" by listing every
 * payment received with its label. Amounts are the booked INR; original
 * currency is shown as a memo column.
 */
export default async function ClientsPage(props: PageProps<"/clients">) {
  await requireCapability("viewAllTransactions");
  const { id } = await props.searchParams;
  const selectedId = typeof id === "string" ? id : null;

  const clients = await prisma.vendor.findMany({
    where: {
      OR: [
        { kind: VendorKind.CLIENT },
        // A vendor row that has received income is a client in practice.
        { transactions: { some: { type: TxnType.INCOME, deletedAt: null } } },
      ],
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      kind: true,
      notes: true,
      isActive: true,
    },
  });

  const totals = await prisma.transaction.groupBy({
    by: ["vendorId"],
    where: {
      type: TxnType.INCOME,
      status: TxnStatus.APPROVED,
      deletedAt: null,
      vendorId: { not: null },
    },
    _sum: { amountInr: true },
    _count: true,
  });

  const totalByVendor = new Map(
    totals.map((t) => [
      t.vendorId as string,
      { amount: dec(t._sum.amountInr ?? 0), count: t._count },
    ]),
  );

  const grandTotal = totals.reduce(
    (sum, t) => sum.plus(dec(t._sum.amountInr ?? 0)),
    dec(0),
  );

  const selected = selectedId ? clients.find((c) => c.id === selectedId) : null;

  const payments = selected
    ? await prisma.transaction.findMany({
        where: { vendorId: selected.id, type: TxnType.INCOME, deletedAt: null },
        orderBy: { date: "desc" },
        include: {
          project: { select: { name: true } },
          category: { select: { name: true } },
        },
      })
    : [];

  return (
    <>
      <PageHeader
        title="Clients & payments"
        description="Who has paid what, and which instalments are still outstanding."
        action={
          <LinkButton href="/directories?tab=vendors" variant="secondary">
            <IconPlus className="h-4 w-4" />
            Add client
          </LinkButton>
        }
      />

      {clients.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconBriefcase className="h-7 w-7" />}
            title="No clients yet"
            description="Add a client to the directory, then record income against them to build a ledger."
            action={
              <LinkButton href="/directories?tab=vendors" variant="primary" size="sm">
                Add a client
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
          <Card className="overflow-hidden">
            <CardHeader
              title="Clients"
              description={`${formatInr(toMoneyStringOrZero(grandTotal))} received in total`}
            />
            <ul className="divide-y divide-line">
              {clients.map((client) => {
                const total = totalByVendor.get(client.id);
                const amount = total?.amount ?? dec(0);
                const active = client.id === selectedId;

                return (
                  <li key={client.id}>
                    <Link
                      href={`/clients?id=${client.id}`}
                      className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
                        active ? "bg-accent-soft" : "hover:bg-surface-2"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{client.name}</p>
                        <p className="mt-0.5 text-[11px] text-ink-muted">
                          {total?.count ?? 0} payment{total?.count === 1 ? "" : "s"}
                          {!client.isActive ? " · inactive" : ""}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-medium tabular text-income">
                          {formatInr(toMoneyStringOrZero(amount))}
                        </p>
                        {!grandTotal.isZero() ? (
                          <p className="text-[10px] text-ink-muted">
                            {formatPercent(
                              Number(amount.div(grandTotal).times(100).toFixed(1)),
                              0,
                            )}
                          </p>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card className="overflow-hidden">
            {!selected ? (
              <EmptyState
                title="Pick a client"
                description="Choose a client on the left to see every payment received, its label, and what's still outstanding."
              />
            ) : (
              <>
                <CardHeader
                  title={selected.name}
                  description={
                    selected.notes ??
                    `${payments.length} payment${payments.length === 1 ? "" : "s"} recorded`
                  }
                  action={
                    <LinkButton
                      href={`/transactions?vendorId=${selected.id}&type=INCOME`}
                      variant="secondary"
                      size="sm"
                    >
                      In transactions
                    </LinkButton>
                  }
                />

                {payments.length === 0 ? (
                  <EmptyState
                    title="No income recorded yet"
                    description="Record a payment against this client and it will appear here."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-muted">
                          <th className="px-4 py-2.5 font-medium">Date</th>
                          <th className="px-4 py-2.5 font-medium">Payment</th>
                          <th className="px-4 py-2.5 font-medium">Project</th>
                          <th className="px-4 py-2.5 font-medium">Original</th>
                          <th className="px-4 py-2.5 text-right font-medium">
                            Booked (INR)
                          </th>
                          <th className="px-4 py-2.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {payments.map((p) => (
                          <tr key={p.id} className="hover:bg-surface-2">
                            <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">
                              {formatDate(p.date)}
                            </td>
                            <td className="px-4 py-2.5">
                              <span className="font-medium">
                                {p.paymentLabel ?? "—"}
                              </span>
                              {p.routing === "VIA_DUBAI_PARTNER" ? (
                                <Badge tone="info" className="ml-1.5">
                                  Dubai
                                </Badge>
                              ) : null}
                            </td>
                            <td className="px-4 py-2.5 text-ink-muted">
                              {p.project?.name ?? "—"}
                            </td>
                            <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">
                              {formatForeign(
                                p.originalAmount ? p.originalAmount.toFixed(2) : null,
                                p.originalCurrency,
                              ) ?? "—"}
                            </td>
                            <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular">
                              {formatInr(p.amountInr.toFixed(2))}
                            </td>
                            <td className="px-4 py-2.5">
                              <Badge
                                tone={
                                  p.status === TxnStatus.APPROVED
                                    ? "approved"
                                    : p.status === TxnStatus.PENDING
                                      ? "pending"
                                      : "rejected"
                                }
                              >
                                {p.status.charAt(0) + p.status.slice(1).toLowerCase()}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-line bg-surface-2/60 font-semibold">
                          <td className="px-4 py-2.5" colSpan={4}>
                            Total approved
                          </td>
                          <td className="px-4 py-2.5 text-right tabular text-income">
                            {formatInr(
                              toMoneyStringOrZero(
                                payments
                                  .filter((p) => p.status === TxnStatus.APPROVED)
                                  .reduce((s, p) => s.plus(dec(p.amountInr)), dec(0)),
                              ),
                            )}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {payments.some((p) => p.status === TxnStatus.PENDING) ? (
                  <p className="border-t border-line px-4 py-2.5 text-[11px] text-ink-muted">
                    Pending payments are excluded from the approved total and from
                    reports until an approver signs them off.
                  </p>
                ) : null}
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
