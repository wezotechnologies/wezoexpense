import { jsonCreated, jsonError, jsonOk, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import {
  computePayout,
  describeBasis,
  isSalaryBasis,
  paiseToAmountString,
  parseRupeesToPaise,
} from "@/lib/salary";
import { createTransaction } from "@/lib/transactions";
import { prisma } from "@/lib/prisma";
import {
  recordSalarySchema,
  recurringTemplateSchema,
  setSalaryBasisSchema,
} from "@/lib/validation";
import { formatMonthKey } from "@/lib/format";

/**
 * POST /api/salary — record a pro-rata salary payment as an expense.
 *
 * The request carries the *inputs*, not the amount: the payable figure is
 * recomputed here with lib/salary.ts, the same module the calculator uses on
 * screen. That keeps a single source of truth for the arithmetic, and means
 * the stored amount is derived rather than asserted by the caller.
 *
 * The working is written into the transaction's notes. Six months on, "why is
 * this ₹25,683.33 and not ₹33,500?" is answerable from the record itself
 * instead of requiring someone to reconstruct the month's day count.
 */
export const POST = route(async (request: Request) => {
  const user = await requireCapability("calculateSalary");
  const input = await parseJson(request, recordSalarySchema);

  if (!isSalaryBasis(input.basis)) {
    return jsonError(422, "Unknown salary basis.");
  }

  // money() has already normalised this to a decimal string.
  const monthlyPaise = parseRupeesToPaise(input.monthlyInr);
  if (monthlyPaise === null || monthlyPaise <= 0) {
    return jsonError(422, "Enter a monthly salary greater than zero.");
  }

  const payout = computePayout({
    monthlyPaise,
    monthKey: input.month,
    basis: input.basis,
    paidHalfDays: input.paidHalfDays,
  });

  if (payout.periodDays <= 0) {
    return jsonError(422, "That month has no days on the chosen basis.");
  }
  if (payout.payablePaise <= 0) {
    return jsonError(
      422,
      "Nothing is payable for zero days — there is no transaction to record.",
    );
  }

  const working =
    `${input.employeeName} — salary for ${formatMonthKey(input.month)}. ` +
    `${payout.paidDays} of ${payout.periodDays} ${describeBasis(input.basis)} paid ` +
    `on a monthly salary of ₹${input.monthlyInr}.`;

  const txn = await createTransaction(user, {
    type: "EXPENSE",
    date: input.date,
    amountInr: paiseToAmountString(payout.payablePaise),
    categoryId: input.categoryId,
    vendorId: input.vendorId,
    projectId: null,
    paymentLabel: null,
    paymentMethod: null,
    notes: input.notes ? `${working}\n\n${input.notes}` : working,
    originalCurrency: null,
    originalAmount: null,
    routing: "DIRECT",
    grossAmount: null,
    grossCurrency: null,
    vatAmount: null,
    vatCurrency: null,
    taxAmount: null,
    receiptBlobKey: null,
    receiptMime: null,
    aiExtracted: false,
    aiConfidence: null,
    aiRaw: null,
    saveAsApproved: input.saveAsApproved,
  });

  return jsonCreated({
    transaction: txn,
    payable: paiseToAmountString(payout.payablePaise),
    lossOfPay: paiseToAmountString(payout.lopPaise),
    periodDays: payout.periodDays,
    paidDays: payout.paidDays,
  });
});

/**
 * PATCH /api/salary — remember a person's working week on their recurring rule.
 *
 * Merges into the existing template rather than replacing it. PATCH
 * /api/recurring takes a whole template and would overwrite every other field
 * with whatever the browser happened to be holding — which, on a page that
 * never loaded the notes or payment method, means silently erasing them.
 */
export const PATCH = route(async (request: Request) => {
  await requireCapability("manageRecurring");
  const input = await parseJson(request, setSalaryBasisSchema);

  const rule = await prisma.recurringRule.findUnique({
    where: { id: input.ruleId },
    select: { id: true, name: true, templateJson: true },
  });
  if (!rule) return jsonError(404, "That employee's rule no longer exists.");

  const parsed = recurringTemplateSchema.safeParse(rule.templateJson);
  if (!parsed.success) {
    return jsonError(422, "That rule's template is not readable.");
  }

  await prisma.recurringRule.update({
    where: { id: rule.id },
    data: { templateJson: { ...parsed.data, salaryBasis: input.basis } },
  });

  return jsonOk({ ruleId: rule.id, name: rule.name, basis: input.basis });
});
