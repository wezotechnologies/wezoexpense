import { z } from "zod";

import { jsonOk, parseJson, parseQuery, route } from "@/lib/api";
import { ApiError, requireCapability } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { budgetLinesForMonth } from "@/lib/budgets";
import { currentMonthKey } from "@/lib/dates";
import { budgetSchema, monthKeySchema } from "@/lib/validation";
import { TxnType } from "@/generated/prisma/enums";

/**
 * GET  /api/budgets?month=YYYY-MM — budgets joined to actual spend.
 * POST /api/budgets               — upsert one category budget for a month.
 * Admin+ only (spec 3).
 */

export const GET = route(async (request: Request) => {
  await requireCapability("manageBudgets");
  const { month } = parseQuery(
    request,
    z.object({ month: monthKeySchema.optional() }),
  );
  const key = month ?? currentMonthKey();

  return jsonOk({ month: key, lines: await budgetLinesForMonth(key) });
});

export const POST = route(async (request: Request) => {
  const user = await requireCapability("manageBudgets");
  const input = await parseJson(request, budgetSchema);

  // Budgets constrain spending, so they only make sense on expense categories.
  const category = await prisma.category.findUnique({
    where: { id: input.categoryId },
    select: { id: true, name: true, type: true },
  });
  if (!category) throw new ApiError(422, "That category no longer exists.");
  if (category.type !== TxnType.EXPENSE) {
    throw new ApiError(422, "Budgets can only be set on expense categories.");
  }

  const before = await prisma.budget.findUnique({
    where: { categoryId_month: { categoryId: input.categoryId, month: input.month } },
  });

  const budget = await prisma.$transaction(async (tx) => {
    const saved = await tx.budget.upsert({
      where: {
        categoryId_month: { categoryId: input.categoryId, month: input.month },
      },
      update: { amountInr: input.amountInr, alertPct: input.alertPct },
      create: {
        categoryId: input.categoryId,
        month: input.month,
        amountInr: input.amountInr,
        alertPct: input.alertPct,
      },
    });

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.SET_BUDGET,
        entity: "Budget",
        entityId: saved.id,
        before: before
          ? { amountInr: before.amountInr, alertPct: before.alertPct }
          : undefined,
        after: {
          category: category.name,
          month: saved.month,
          amountInr: saved.amountInr,
          alertPct: saved.alertPct,
        },
      },
      tx,
    );

    return saved;
  });

  return jsonOk({
    budget: {
      id: budget.id,
      categoryId: budget.categoryId,
      month: budget.month,
      amountInr: budget.amountInr.toFixed(2),
      alertPct: budget.alertPct,
    },
  });
});

export const DELETE = route(async (request: Request) => {
  const user = await requireCapability("manageBudgets");
  const { id } = await parseJson(
    request,
    z.object({ id: z.string().min(1).max(64) }),
  );

  const existing = await prisma.budget.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, "That budget no longer exists.");

  await prisma.$transaction(async (tx) => {
    await tx.budget.delete({ where: { id } });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.DELETE_BUDGET,
        entity: "Budget",
        entityId: id,
        before: {
          categoryId: existing.categoryId,
          month: existing.month,
          amountInr: existing.amountInr,
        },
      },
      tx,
    );
  });

  return jsonOk({ ok: true });
});
