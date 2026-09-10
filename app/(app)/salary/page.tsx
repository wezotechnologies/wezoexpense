import type { Metadata } from "next";

import { SalaryCalculator } from "@/components/salary-calculator";
import { PageHeader } from "@/components/ui/primitives";
import { currentMonthKey, todayDateKey } from "@/lib/dates";
import { toMoneyStringOrZero } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/rbac";
import { TxnType } from "@/generated/prisma/enums";
import { recurringTemplateSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Salary calculator" };

/**
 * Pro-rata salary calculator.
 *
 * The people you pay are already in the books as recurring expense rules, so
 * those are offered as presets: picking one fills in the name, the monthly
 * figure and the category, which is the part that actually costs time. Nothing
 * here depends on them — a name and an amount typed by hand work identically.
 */
export default async function SalaryPage() {
  await requireCapability("calculateSalary");

  const [rules, categories, vendors] = await Promise.all([
    prisma.recurringRule.findMany({
      where: { isActive: true, type: TxnType.EXPENSE },
      orderBy: { name: "asc" },
      select: { id: true, name: true, templateJson: true },
    }),
    prisma.category.findMany({
      where: { isActive: true, type: TxnType.EXPENSE },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.vendor.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));

  const presets = rules.flatMap((rule) => {
    const parsed = recurringTemplateSchema.safeParse(rule.templateJson);
    if (!parsed.success) return [];
    const categoryId = parsed.data.categoryId ?? null;
    return [
      {
        id: rule.id,
        name: rule.name,
        monthlyInr: toMoneyStringOrZero(parsed.data.amountInr),
        categoryId,
        categoryName: categoryId ? (categoryNames.get(categoryId) ?? null) : null,
        vendorId: parsed.data.vendorId ?? null,
        // null when this person has never had a working week recorded; the
        // calculator falls back to the default rather than guessing.
        basis: parsed.data.salaryBasis ?? null,
      },
    ];
  });

  return (
    <>
      <PageHeader
        title="Salary calculator"
        description="Work out a part-month salary, then record the payment without retyping it."
      />

      <SalaryCalculator
        presets={presets}
        categories={categories}
        vendors={vendors}
        defaultMonth={currentMonthKey()}
        today={todayDateKey()}
      />
    </>
  );
}
