import "server-only";

import { prisma } from "@/lib/prisma";
import { ApiError, type SessionUser } from "@/lib/rbac";
import { AuditAction, recordAudit } from "@/lib/audit";
import { monthRangeUtc } from "@/lib/dates";
import { notifyApprovers } from "@/lib/notifications";
import { NotificationKind, TxnStatus } from "@/generated/prisma/enums";
import { toMoneyStringOrZero } from "@/lib/money";

/**
 * Monthly close / period lock (spec 7.5, 11).
 *
 * Closing a month stamps `periodLocked` on every transaction dated in it and
 * records a PeriodLock row. After that only a Superadmin can write into the
 * month, and only by reopening it — which prevents retroactive tampering while
 * leaving a Superadmin a documented way to fix a genuine mistake.
 */

export type PeriodSummary = {
  month: string;
  locked: boolean;
  lockedAt: string | null;
  lockedByName: string | null;
  transactionCount: number;
  pendingCount: number;
  incomeInr: string;
  expenseInr: string;
};

export async function summarisePeriod(month: string): Promise<PeriodSummary> {
  const range = monthRangeUtc(month);
  const where = { deletedAt: null, date: { gte: range.gte, lt: range.lt } };

  const [lock, count, pending, grouped] = await Promise.all([
    prisma.periodLock.findUnique({
      where: { month },
      include: { lockedBy: { select: { name: true } } },
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.count({ where: { ...where, status: TxnStatus.PENDING } }),
    prisma.transaction.groupBy({
      by: ["type"],
      where: { ...where, status: TxnStatus.APPROVED },
      _sum: { amountInr: true },
    }),
  ]);

  return {
    month,
    locked: !!lock,
    lockedAt: lock?.lockedAt.toISOString() ?? null,
    lockedByName: lock?.lockedBy?.name ?? null,
    transactionCount: count,
    pendingCount: pending,
    incomeInr: toMoneyStringOrZero(
      grouped.find((g) => g.type === "INCOME")?._sum.amountInr ?? 0,
    ),
    expenseInr: toMoneyStringOrZero(
      grouped.find((g) => g.type === "EXPENSE")?._sum.amountInr ?? 0,
    ),
  };
}

export async function lockPeriod(
  user: SessionUser,
  month: string,
): Promise<PeriodSummary> {
  const existing = await prisma.periodLock.findUnique({ where: { month } });
  if (existing) throw new ApiError(409, `${month} is already closed.`);

  const range = monthRangeUtc(month);

  // Closing a month with unreviewed submissions would silently freeze them, so
  // require the queue to be cleared first.
  const pending = await prisma.transaction.count({
    where: {
      deletedAt: null,
      status: TxnStatus.PENDING,
      date: { gte: range.gte, lt: range.lt },
    },
  });
  if (pending > 0) {
    throw new ApiError(
      409,
      `${month} still has ${pending} submission${pending === 1 ? "" : "s"} awaiting approval. Clear the queue before closing the month.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.periodLock.create({ data: { month, lockedById: user.id } });
    await tx.transaction.updateMany({
      where: { date: { gte: range.gte, lt: range.lt } },
      data: { periodLocked: true },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.LOCK_PERIOD,
        entity: "PeriodLock",
        entityId: month,
        after: { month },
      },
      tx,
    );
  });

  await notifyApprovers(
    {
      kind: NotificationKind.PERIOD_LOCKED,
      title: `${month} has been closed`,
      body: `${user.name} closed the books for ${month}.`,
      link: `/close`,
    },
    user.id,
  ).catch((e) => console.error("[notify] period lock:", e));

  return summarisePeriod(month);
}

/** Superadmin only (spec 3). */
export async function unlockPeriod(
  user: SessionUser,
  month: string,
): Promise<PeriodSummary> {
  const existing = await prisma.periodLock.findUnique({ where: { month } });
  if (!existing) throw new ApiError(409, `${month} is not closed.`);

  const range = monthRangeUtc(month);

  await prisma.$transaction(async (tx) => {
    await tx.periodLock.delete({ where: { month } });
    await tx.transaction.updateMany({
      where: { date: { gte: range.gte, lt: range.lt } },
      data: { periodLocked: false },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.UNLOCK_PERIOD,
        entity: "PeriodLock",
        entityId: month,
        before: { month, lockedAt: existing.lockedAt },
      },
      tx,
    );
  });

  return summarisePeriod(month);
}

/** Recent months with their close state, for the Monthly close screen. */
export async function recentPeriods(monthKeys: string[]): Promise<PeriodSummary[]> {
  return Promise.all(monthKeys.map(summarisePeriod));
}
