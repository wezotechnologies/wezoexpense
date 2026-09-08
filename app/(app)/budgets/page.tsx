import type { Metadata } from "next";

import { BudgetsManager } from "@/components/budgets-manager";
import { MonthPicker } from "@/components/month-picker";
import { PageHeader } from "@/components/ui/primitives";
import { budgetLinesForMonth } from "@/lib/budgets";
import { currentMonthKey } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/rbac";
import { monthKeySchema } from "@/lib/validation";
import { TxnType } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Budgets" };

export default async function BudgetsPage(props: PageProps<"/budgets">) {
  await requireCapability("manageBudgets");
  const searchParams = await props.searchParams;

  const parsed = monthKeySchema.safeParse(searchParams.month);
  const month = parsed.success ? parsed.data : currentMonthKey();

  const [lines, categories] = await Promise.all([
    budgetLinesForMonth(month),
    prisma.category.findMany({
      where: { type: TxnType.EXPENSE, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Set monthly limits per expense category and get alerted before they run out."
        action={<MonthPicker month={month} basePath="/budgets" />}
      />

      <BudgetsManager month={month} lines={lines} categories={categories} />
    </>
  );
}
