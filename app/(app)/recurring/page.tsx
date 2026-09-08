import type { Metadata } from "next";

import { RecurringManager } from "@/components/recurring-manager";
import { PageHeader } from "@/components/ui/primitives";
import { todayDateKey } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/rbac";
import { serializeRule } from "@/lib/recurring";

export const metadata: Metadata = { title: "Recurring" };

export default async function RecurringPage() {
  await requireCapability("manageRecurring");

  const [rules, categories, vendors] = await Promise.all([
    prisma.recurringRule.findMany({
      orderBy: [{ isActive: "desc" }, { nextRunDate: "asc" }],
      include: { _count: { select: { transactions: true } } },
    }),
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    prisma.vendor.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Recurring transactions"
        description="Anything that repeats on a schedule — rent, salaries, subscriptions."
      />

      <RecurringManager
        rules={await Promise.all(rules.map(serializeRule))}
        categories={categories}
        vendors={vendors}
        today={todayDateKey()}
      />
    </>
  );
}
