import "server-only";

import { prisma } from "@/lib/prisma";
import {
  ApiError,
  canEditTransaction,
  canViewTransaction,
  isAdminPlus,
  isSuperadmin,
  transactionScope,
  type SessionUser,
} from "@/lib/rbac";
import { AuditAction, auditableTxnFields, recordAudit, toJson } from "@/lib/audit";
import { dec, deriveFxRate, toMoneyString, toMoneyStringOrZero } from "@/lib/money";
import { istDateToUtc, monthKeyOf } from "@/lib/dates";
import { getSettings } from "@/lib/settings";
import { notify, notifyApprovers } from "@/lib/notifications";
import { checkBudgetThreshold } from "@/lib/budgets";
import { NotificationKind, TxnStatus, TxnType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type {
  CreateTransactionInput,
  TransactionFilter,
  UpdateTransactionInput,
} from "@/lib/validation";

/**
 * Transaction service (spec 7). Everything that writes a Transaction goes
 * through here so the invariants live in one place:
 *
 *  - `amountInr` is the booked figure; `fxRate` is always derived, never taken
 *    from the client (spec 5.2).
 *  - A category must belong to the same side of the books as the transaction.
 *  - A closed month is immutable except to a Superadmin (spec 7.5).
 *  - Every write appends to the audit log, in the same database transaction.
 */

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

const listInclude = {
  category: { select: { id: true, name: true, type: true } },
  vendor: { select: { id: true, name: true, kind: true } },
  project: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.TransactionInclude;

export type TransactionWithRelations = Prisma.TransactionGetPayload<{
  include: typeof listInclude;
}>;

/** Wire format: Decimals become strings so values survive the RSC boundary. */
export type TransactionDTO = {
  id: string;
  type: TxnType;
  status: TxnStatus;
  date: string;
  amountInr: string;
  originalCurrency: string | null;
  originalAmount: string | null;
  fxRate: string | null;
  categoryId: string | null;
  categoryName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  projectId: string | null;
  projectName: string | null;
  paymentLabel: string | null;
  paymentMethod: string | null;
  notes: string | null;
  routing: "DIRECT" | "VIA_DUBAI_PARTNER";
  grossAmount: string | null;
  grossCurrency: string | null;
  vatAmount: string | null;
  vatCurrency: string | null;
  taxAmount: string | null;
  hasReceipt: boolean;
  receiptMime: string | null;
  aiExtracted: boolean;
  aiConfidence: number | null;
  createdById: string;
  createdByName: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  periodLocked: boolean;
  createdAt: string;
  updatedAt: string;
};

export function serializeTransaction(
  txn: TransactionWithRelations,
): TransactionDTO {
  return {
    id: txn.id,
    type: txn.type,
    status: txn.status,
    date: txn.date.toISOString(),
    amountInr: toMoneyString(txn.amountInr) ?? "0.00",
    originalCurrency: txn.originalCurrency,
    originalAmount: toMoneyString(txn.originalAmount),
    fxRate: txn.fxRate ? txn.fxRate.toFixed(6) : null,
    categoryId: txn.categoryId,
    categoryName: txn.category?.name ?? null,
    vendorId: txn.vendorId,
    vendorName: txn.vendor?.name ?? null,
    projectId: txn.projectId,
    projectName: txn.project?.name ?? null,
    paymentLabel: txn.paymentLabel,
    paymentMethod: txn.paymentMethod,
    notes: txn.notes,
    routing: txn.routing,
    grossAmount: toMoneyString(txn.grossAmount),
    grossCurrency: txn.grossCurrency,
    vatAmount: toMoneyString(txn.vatAmount),
    vatCurrency: txn.vatCurrency,
    taxAmount: toMoneyString(txn.taxAmount),
    hasReceipt: !!txn.receiptBlobKey,
    receiptMime: txn.receiptMime,
    aiExtracted: txn.aiExtracted,
    aiConfidence: txn.aiConfidence,
    createdById: txn.createdById,
    createdByName: txn.createdBy?.name ?? "—",
    reviewedByName: txn.reviewedBy?.name ?? null,
    reviewedAt: txn.reviewedAt?.toISOString() ?? null,
    rejectionReason: txn.rejectionReason,
    periodLocked: txn.periodLocked,
    createdAt: txn.createdAt.toISOString(),
    updatedAt: txn.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** A category must sit on the same side of the books as the transaction. */
async function assertCategoryMatchesType(
  categoryId: string | null,
  type: TxnType,
): Promise<void> {
  if (!categoryId) return;
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true, type: true, isActive: true, name: true },
  });
  if (!category) throw new ApiError(422, "That category no longer exists.");
  if (category.type !== type) {
    throw new ApiError(
      422,
      `"${category.name}" is an ${category.type.toLowerCase()} category and can't be used on ${type === TxnType.INCOME ? "an income" : "an expense"} transaction.`,
    );
  }
}

async function assertReferencesExist(input: {
  vendorId: string | null;
  projectId: string | null;
}): Promise<void> {
  if (input.vendorId) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: input.vendorId },
      select: { id: true },
    });
    if (!vendor) throw new ApiError(422, "That vendor/client no longer exists.");
  }
  if (input.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) throw new ApiError(422, "That project no longer exists.");
  }
}

export async function isMonthLocked(monthKey: string): Promise<boolean> {
  const lock = await prisma.periodLock.findUnique({
    where: { month: monthKey },
    select: { id: true },
  });
  return !!lock;
}

/**
 * A closed month is sealed against retroactive tampering. Only a Superadmin can
 * write into one (and they must unlock it to let others in) — spec 7.5.
 */
async function assertPeriodWritable(
  user: SessionUser,
  date: Date,
): Promise<boolean> {
  const month = monthKeyOf(date);
  const locked = await isMonthLocked(month);
  if (locked && !isSuperadmin(user)) {
    throw new ApiError(
      423,
      `${month} has been closed. Ask a Superadmin to reopen it before making changes.`,
    );
  }
  return locked;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Decides the initial status per spec 7.1 step 5. */
export function initialStatus(
  user: SessionUser,
  approvalRequired: boolean,
  saveAsApproved: boolean,
): TxnStatus {
  if (isAdminPlus(user)) {
    return saveAsApproved ? TxnStatus.APPROVED : TxnStatus.PENDING;
  }
  // Employees can never self-approve.
  return approvalRequired ? TxnStatus.PENDING : TxnStatus.APPROVED;
}

export async function createTransaction(
  user: SessionUser,
  input: CreateTransactionInput,
): Promise<TransactionDTO> {
  const date = istDateToUtc(input.date);
  const periodLocked = await assertPeriodWritable(user, date);

  await assertCategoryMatchesType(input.categoryId, input.type);
  await assertReferencesExist(input);

  const settings = await getSettings();
  const status = initialStatus(user, settings.approvalRequired, input.saveAsApproved);

  // Derived, never trusted from the client (spec 5.2).
  const fxRate = deriveFxRate(input.amountInr, input.originalAmount);

  const approvedNow = status === TxnStatus.APPROVED;

  const created = await prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.create({
      data: {
        type: input.type,
        status,
        date,
        amountInr: input.amountInr,
        originalCurrency: input.originalCurrency,
        originalAmount: input.originalAmount,
        fxRate: fxRate ? fxRate.toFixed(6) : null,
        categoryId: input.categoryId,
        vendorId: input.vendorId,
        projectId: input.projectId,
        paymentLabel: input.paymentLabel,
        paymentMethod: input.paymentMethod,
        notes: input.notes,
        routing: input.routing,
        grossAmount: input.grossAmount,
        grossCurrency: input.grossCurrency,
        vatAmount: input.vatAmount,
        vatCurrency: input.vatCurrency,
        taxAmount: input.taxAmount,
        receiptBlobKey: input.receiptBlobKey,
        receiptMime: input.receiptMime,
        aiExtracted: input.aiExtracted,
        aiConfidence: input.aiConfidence ?? null,
        aiRaw: input.aiRaw ? toJson(input.aiRaw) : undefined,
        createdById: user.id,
        periodLocked,
        ...(approvedNow
          ? { reviewedById: user.id, reviewedAt: new Date() }
          : {}),
      },
      include: listInclude,
    });

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.CREATE_TXN,
        entity: "Transaction",
        entityId: txn.id,
        after: auditableTxnFields(txn as unknown as Record<string, unknown>),
      },
      tx,
    );

    return txn;
  });

  // Side effects outside the write transaction — a notification failure must
  // never roll back a saved transaction.
  if (status === TxnStatus.PENDING) {
    await notifyApprovers(
      {
        kind: NotificationKind.SUBMISSION_PENDING,
        title: `${user.name} submitted a ${input.type.toLowerCase()}`,
        body: `₹${input.amountInr} awaiting approval.`,
        link: `/approvals`,
      },
      user.id,
    ).catch((e) => console.error("[notify] approvers:", e));
  }

  if (approvedNow && created.type === TxnType.EXPENSE) {
    await checkBudgetThreshold(created.categoryId, created.date).catch((e) =>
      console.error("[budget] threshold check:", e),
    );
  }

  return serializeTransaction(created);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateTransaction(
  user: SessionUser,
  id: string,
  input: UpdateTransactionInput,
): Promise<TransactionDTO> {
  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new ApiError(404, "That transaction no longer exists.");
  }

  // Someone who may not even see this row gets the same 404 as for a missing
  // one, so probing ids can't distinguish "not yours" from "doesn't exist".
  if (!canViewTransaction(user, existing)) {
    throw new ApiError(404, "That transaction no longer exists.");
  }

  if (!canEditTransaction(user, existing)) {
    throw new ApiError(
      403,
      existing.periodLocked
        ? "That month has been closed. Ask a Superadmin to reopen it."
        : isAdminPlus(user)
          ? "That transaction cannot be edited."
          : "You can only edit your own submissions while they are still pending.",
    );
  }

  const date = istDateToUtc(input.date);
  // Both the old and the new month must be open.
  await assertPeriodWritable(user, existing.date);
  const periodLocked = await assertPeriodWritable(user, date);

  await assertCategoryMatchesType(input.categoryId, input.type);
  await assertReferencesExist(input);

  // Only an approver may change status through this route.
  const nextStatus =
    input.status && isAdminPlus(user) ? input.status : existing.status;

  const fxRate = deriveFxRate(input.amountInr, input.originalAmount);

  const updated = await prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.update({
      where: { id },
      data: {
        type: input.type,
        status: nextStatus,
        date,
        amountInr: input.amountInr,
        originalCurrency: input.originalCurrency,
        originalAmount: input.originalAmount,
        fxRate: fxRate ? fxRate.toFixed(6) : null,
        categoryId: input.categoryId,
        vendorId: input.vendorId,
        projectId: input.projectId,
        paymentLabel: input.paymentLabel,
        paymentMethod: input.paymentMethod,
        notes: input.notes,
        routing: input.routing,
        grossAmount: input.grossAmount,
        grossCurrency: input.grossCurrency,
        vatAmount: input.vatAmount,
        vatCurrency: input.vatCurrency,
        taxAmount: input.taxAmount,
        receiptBlobKey: input.receiptBlobKey,
        receiptMime: input.receiptMime,
        periodLocked,
      },
      include: listInclude,
    });

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.EDIT_TXN,
        entity: "Transaction",
        entityId: id,
        before: auditableTxnFields(existing as unknown as Record<string, unknown>),
        after: auditableTxnFields(txn as unknown as Record<string, unknown>),
      },
      tx,
    );

    return txn;
  });

  return serializeTransaction(updated);
}

// ---------------------------------------------------------------------------
// Approve / reject (spec 7.3)
// ---------------------------------------------------------------------------

export async function approveTransaction(
  user: SessionUser,
  id: string,
): Promise<TransactionDTO> {
  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new ApiError(404, "That transaction no longer exists.");
  }
  if (existing.status === TxnStatus.APPROVED) {
    throw new ApiError(409, "That transaction is already approved.");
  }
  if (existing.createdById === user.id && !isSuperadmin(user)) {
    throw new ApiError(
      403,
      "You can't approve your own submission. Ask another approver to review it.",
    );
  }
  await assertPeriodWritable(user, existing.date);

  const updated = await prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.update({
      where: { id },
      data: {
        status: TxnStatus.APPROVED,
        reviewedById: user.id,
        reviewedAt: new Date(),
        rejectionReason: null,
      },
      include: listInclude,
    });

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.APPROVE_TXN,
        entity: "Transaction",
        entityId: id,
        before: { status: existing.status },
        after: { status: txn.status, reviewedById: user.id },
      },
      tx,
    );

    return txn;
  });

  await notify({
    userId: updated.createdById,
    kind: NotificationKind.SUBMISSION_APPROVED,
    title: "Your submission was approved",
    body: `${updated.type === TxnType.INCOME ? "Income" : "Expense"} of ₹${toMoneyString(updated.amountInr)} approved by ${user.name}.`,
    link: `/transactions?id=${updated.id}`,
  }).catch((e) => console.error("[notify] approval:", e));

  if (updated.type === TxnType.EXPENSE) {
    await checkBudgetThreshold(updated.categoryId, updated.date).catch((e) =>
      console.error("[budget] threshold check:", e),
    );
  }

  return serializeTransaction(updated);
}

export async function rejectTransaction(
  user: SessionUser,
  id: string,
  reason: string,
): Promise<TransactionDTO> {
  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new ApiError(404, "That transaction no longer exists.");
  }
  if (existing.status === TxnStatus.REJECTED) {
    throw new ApiError(409, "That transaction is already rejected.");
  }
  await assertPeriodWritable(user, existing.date);

  const updated = await prisma.$transaction(async (tx) => {
    const txn = await tx.transaction.update({
      where: { id },
      data: {
        status: TxnStatus.REJECTED,
        reviewedById: user.id,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
      include: listInclude,
    });

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.REJECT_TXN,
        entity: "Transaction",
        entityId: id,
        before: { status: existing.status },
        after: { status: txn.status, rejectionReason: reason },
      },
      tx,
    );

    return txn;
  });

  await notify({
    userId: updated.createdById,
    kind: NotificationKind.SUBMISSION_REJECTED,
    title: "Your submission was rejected",
    body: reason,
    link: `/transactions?id=${updated.id}`,
  }).catch((e) => console.error("[notify] rejection:", e));

  return serializeTransaction(updated);
}

// ---------------------------------------------------------------------------
// Delete (soft — spec 14)
// ---------------------------------------------------------------------------

export async function softDeleteTransaction(
  user: SessionUser,
  id: string,
): Promise<void> {
  const existing = await prisma.transaction.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new ApiError(404, "That transaction no longer exists.");
  }
  await assertPeriodWritable(user, existing.date);

  await prisma.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.DELETE_TXN,
        entity: "Transaction",
        entityId: id,
        before: auditableTxnFields(existing as unknown as Record<string, unknown>),
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Builds the Prisma where clause for a filter set, already role-scoped. */
export function buildWhere(
  user: SessionUser,
  filter: Partial<TransactionFilter>,
): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = { ...transactionScope(user) };

  if (filter.type) where.type = filter.type;
  if (filter.status) where.status = filter.status;
  if (filter.categoryId) where.categoryId = filter.categoryId;
  if (filter.vendorId) where.vendorId = filter.vendorId;
  if (filter.projectId) where.projectId = filter.projectId;
  if (filter.routing) where.routing = filter.routing;

  // An Employee's scope is already pinned to themselves; this filter only
  // narrows further for Admins looking at one person's submissions.
  if (filter.createdById && isAdminPlus(user)) {
    where.createdById = filter.createdById;
  }

  if (filter.currency) {
    const code = filter.currency.toUpperCase();
    if (code === "INR") {
      // A row with no original currency recorded is an INR transaction, since
      // INR is the books' own currency and needs no conversion note.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ originalCurrency: null }, { originalCurrency: "INR" }] },
      ];
    } else {
      where.originalCurrency = code;
    }
  }

  if (filter.from || filter.to) {
    where.date = {};
    if (filter.from) where.date.gte = istDateToUtc(filter.from);
    if (filter.to) {
      where.date.lt = new Date(
        istDateToUtc(filter.to).getTime() + 24 * 60 * 60 * 1000,
      );
    }
  }

  // Global search (spec 11): vendor, notes, label, or an exact amount.
  if (filter.q) {
    const q = filter.q.trim();
    const clauses: Prisma.TransactionWhereInput[] = [
      { notes: { contains: q, mode: "insensitive" } },
      { paymentLabel: { contains: q, mode: "insensitive" } },
      { paymentMethod: { contains: q, mode: "insensitive" } },
      { vendor: { name: { contains: q, mode: "insensitive" } } },
      { category: { name: { contains: q, mode: "insensitive" } } },
      { project: { name: { contains: q, mode: "insensitive" } } },
    ];
    if (/^\d+(\.\d{1,2})?$/.test(q)) {
      clauses.push({ amountInr: { equals: q } });
    }
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: clauses }];
  }

  return where;
}

export async function listTransactions(
  user: SessionUser,
  filter: TransactionFilter,
): Promise<{
  rows: TransactionDTO[];
  total: number;
  page: number;
  perPage: number;
  totals: { income: string; expense: string; net: string };
}> {
  const where = buildWhere(user, filter);

  const [total, rows, grouped] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      include: listInclude,
      orderBy: [{ [filter.sort]: filter.dir }, { id: "desc" }],
      skip: (filter.page - 1) * filter.perPage,
      take: filter.perPage,
    }),
    // Totals for the whole filter, not just the current page.
    prisma.transaction.groupBy({
      by: ["type"],
      where,
      _sum: { amountInr: true },
    }),
  ]);

  // Decimal throughout — the net must never round-trip through a float.
  const income = dec(grouped.find((g) => g.type === TxnType.INCOME)?._sum.amountInr ?? 0);
  const expense = dec(grouped.find((g) => g.type === TxnType.EXPENSE)?._sum.amountInr ?? 0);

  return {
    rows: rows.map(serializeTransaction),
    total,
    page: filter.page,
    perPage: filter.perPage,
    totals: {
      income: toMoneyStringOrZero(income),
      expense: toMoneyStringOrZero(expense),
      net: toMoneyStringOrZero(income.minus(expense)),
    },
  };
}

/** Single transaction, respecting role scope. */
export async function getTransaction(
  user: SessionUser,
  id: string,
): Promise<TransactionWithRelations | null> {
  const txn = await prisma.transaction.findFirst({
    where: { id, ...transactionScope(user) },
    include: listInclude,
  });
  return txn;
}

export { listInclude };
