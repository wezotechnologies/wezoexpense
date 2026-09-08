import "server-only";

import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { advanceByFrequency, monthKeyOf } from "@/lib/dates";
import { deriveFxRate, toMoneyStringOrZero } from "@/lib/money";
import { notifyApprovers } from "@/lib/notifications";
import { recurringTemplateSchema } from "@/lib/validation";
import { NotificationKind, TxnStatus } from "@/generated/prisma/enums";
import type { RecurringRule } from "@/generated/prisma/client";

/**
 * Recurring transactions (spec 7.4, 11).
 *
 * A rule stores a template plus the next date it should fire. The cron route
 * calls `runDueRules`, which stamps out a transaction for every period that has
 * come due and advances the rule.
 *
 * Two deliberate behaviours:
 *  - Catch-up: if the scheduler was down for two months, both months are
 *    generated rather than silently skipped. A per-run ceiling stops a
 *    misconfigured rule from generating thousands of rows.
 *  - Closed months are skipped, not written into: a rule must never reopen a
 *    period that has been closed (spec 7.5). The rule still advances past it.
 */

/** Safety ceiling on how many periods one rule may catch up in a single run. */
const MAX_CATCHUP_PER_RULE = 24;

export type RecurringRuleDTO = {
  id: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  frequency: "WEEKLY" | "MONTHLY" | "YEARLY";
  nextRunDate: string;
  isActive: boolean;
  autoApprove: boolean;
  lastRunAt: string | null;
  amountInr: string;
  categoryId: string | null;
  categoryName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  notes: string | null;
  generatedCount: number;
};

type RuleWithRelations = RecurringRule & {
  _count: { transactions: number };
};

export async function serializeRule(
  rule: RuleWithRelations,
): Promise<RecurringRuleDTO> {
  const template = recurringTemplateSchema.safeParse(rule.templateJson);
  const t = template.success ? template.data : null;

  const [category, vendor] = await Promise.all([
    t?.categoryId
      ? prisma.category.findUnique({
          where: { id: t.categoryId },
          select: { name: true },
        })
      : null,
    t?.vendorId
      ? prisma.vendor.findUnique({
          where: { id: t.vendorId },
          select: { name: true },
        })
      : null,
  ]);

  return {
    id: rule.id,
    name: rule.name,
    type: rule.type,
    frequency: rule.frequency,
    nextRunDate: rule.nextRunDate.toISOString(),
    isActive: rule.isActive,
    autoApprove: rule.autoApprove,
    lastRunAt: rule.lastRunAt?.toISOString() ?? null,
    amountInr: t ? toMoneyStringOrZero(t.amountInr) : "0.00",
    categoryId: t?.categoryId ?? null,
    categoryName: category?.name ?? null,
    vendorId: t?.vendorId ?? null,
    vendorName: vendor?.name ?? null,
    notes: t?.notes ?? null,
    generatedCount: rule._count.transactions,
  };
}

export type RunReport = {
  ranAt: string;
  rulesConsidered: number;
  created: number;
  skippedLockedMonths: number;
  errors: Array<{ ruleId: string; ruleName: string; message: string }>;
  details: Array<{
    ruleId: string;
    ruleName: string;
    transactionId: string;
    date: string;
    amountInr: string;
    status: TxnStatus;
  }>;
};

/**
 * Generates transactions for every rule whose nextRunDate has passed.
 * `actorId` is the user credited in the audit log — the triggering Admin, or
 * the system Superadmin when fired by the scheduler.
 */
export async function runDueRules(
  actorId: string,
  now: Date = new Date(),
): Promise<RunReport> {
  const due = await prisma.recurringRule.findMany({
    where: { isActive: true, nextRunDate: { lte: now } },
    orderBy: { nextRunDate: "asc" },
  });

  const report: RunReport = {
    ranAt: now.toISOString(),
    rulesConsidered: due.length,
    created: 0,
    skippedLockedMonths: 0,
    errors: [],
    details: [],
  };

  // Months already closed — a rule must not write into one.
  const locks = await prisma.periodLock.findMany({ select: { month: true } });
  const lockedMonths = new Set(locks.map((l) => l.month));

  for (const rule of due) {
    const parsed = recurringTemplateSchema.safeParse(rule.templateJson);
    if (!parsed.success) {
      report.errors.push({
        ruleId: rule.id,
        ruleName: rule.name,
        message: "The rule's template is no longer valid. Edit and re-save it.",
      });
      continue;
    }
    const template = parsed.data;

    let cursor = rule.nextRunDate;
    let generated = 0;

    try {
      while (cursor <= now && generated < MAX_CATCHUP_PER_RULE) {
        const month = monthKeyOf(cursor);

        if (lockedMonths.has(month)) {
          report.skippedLockedMonths++;
        } else {
          const status = rule.autoApprove
            ? TxnStatus.APPROVED
            : TxnStatus.PENDING;
          const fxRate = deriveFxRate(template.amountInr, template.originalAmount);
          const occurrenceDate = cursor;

          const created = await prisma.$transaction(async (tx) => {
            const txn = await tx.transaction.create({
              data: {
                type: rule.type,
                status,
                date: occurrenceDate,
                amountInr: template.amountInr,
                originalCurrency: template.originalCurrency,
                originalAmount: template.originalAmount,
                fxRate: fxRate ? fxRate.toFixed(6) : null,
                categoryId: template.categoryId,
                vendorId: template.vendorId,
                projectId: template.projectId,
                paymentLabel: template.paymentLabel,
                paymentMethod: template.paymentMethod,
                notes: template.notes ?? `Generated by recurring rule "${rule.name}"`,
                routing: template.routing,
                createdById: actorId,
                recurringId: rule.id,
                ...(status === TxnStatus.APPROVED
                  ? { reviewedById: actorId, reviewedAt: now }
                  : {}),
              },
            });

            await recordAudit(
              {
                actorId,
                action: AuditAction.RUN_RECURRING,
                entity: "Transaction",
                entityId: txn.id,
                after: {
                  rule: rule.name,
                  ruleId: rule.id,
                  date: txn.date,
                  amountInr: txn.amountInr,
                  status: txn.status,
                },
              },
              tx,
            );

            return txn;
          });

          report.created++;
          report.details.push({
            ruleId: rule.id,
            ruleName: rule.name,
            transactionId: created.id,
            date: created.date.toISOString(),
            amountInr: toMoneyStringOrZero(created.amountInr),
            status: created.status,
          });

          if (status === TxnStatus.PENDING) {
            await notifyApprovers({
              kind: NotificationKind.SUBMISSION_PENDING,
              title: `Recurring ${rule.type.toLowerCase()}: ${rule.name}`,
              body: `₹${toMoneyStringOrZero(created.amountInr)} awaiting approval.`,
              link: "/approvals",
            }).catch((e) => console.error("[notify] recurring:", e));
          }
        }

        cursor = advanceByFrequency(cursor, rule.frequency);
        generated++;
      }

      await prisma.recurringRule.update({
        where: { id: rule.id },
        data: { nextRunDate: cursor, lastRunAt: now },
      });
    } catch (error) {
      console.error(`[recurring] rule ${rule.id} failed:`, error);
      report.errors.push({
        ruleId: rule.id,
        ruleName: rule.name,
        message: error instanceof Error ? error.message : "Unknown error.",
      });
    }
  }

  return report;
}
