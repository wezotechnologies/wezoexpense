import { jsonCreated, jsonOk, parseJson, route } from "@/lib/api";
import { ApiError, requireCapability } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { istDateToUtc } from "@/lib/dates";
import { serializeRule } from "@/lib/recurring";
import {
  recurringCreateSchema,
  recurringTemplateSchema,
  recurringUpdateSchema,
} from "@/lib/validation";
import { TxnType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

/** Recurring rules — Admin+ (spec 3, 7.4, 12). */

const withCount = { _count: { select: { transactions: true } } };

export const GET = route(async () => {
  await requireCapability("manageRecurring");

  const rules = await prisma.recurringRule.findMany({
    orderBy: [{ isActive: "desc" }, { nextRunDate: "asc" }],
    include: withCount,
  });

  return jsonOk({ rules: await Promise.all(rules.map(serializeRule)) });
});

/** A rule's category must sit on the same side of the books as the rule. */
async function assertTemplateValid(
  categoryId: string | null,
  type: TxnType,
): Promise<void> {
  if (!categoryId) return;
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { type: true, name: true },
  });
  if (!category) throw new ApiError(422, "That category no longer exists.");
  if (category.type !== type) {
    throw new ApiError(
      422,
      `"${category.name}" is an ${category.type.toLowerCase()} category and can't be used on ${type === TxnType.INCOME ? "an income" : "an expense"} rule.`,
    );
  }
}

export const POST = route(async (request: Request) => {
  const user = await requireCapability("manageRecurring");
  const input = await parseJson(request, recurringCreateSchema);

  await assertTemplateValid(input.template.categoryId, input.type);

  const rule = await prisma.$transaction(async (tx) => {
    const created = await tx.recurringRule.create({
      data: {
        name: input.name,
        type: input.type,
        frequency: input.frequency,
        nextRunDate: istDateToUtc(input.nextRunDate),
        autoApprove: input.autoApprove,
        isActive: input.isActive,
        templateJson: input.template,
      },
      include: withCount,
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.CREATE_RECURRING,
        entity: "RecurringRule",
        entityId: created.id,
        after: {
          name: created.name,
          type: created.type,
          frequency: created.frequency,
          nextRunDate: created.nextRunDate,
          autoApprove: created.autoApprove,
        },
      },
      tx,
    );
    return created;
  });

  return jsonCreated({ rule: await serializeRule(rule) });
});

export const PATCH = route(async (request: Request) => {
  const user = await requireCapability("manageRecurring");
  const input = await parseJson(request, recurringUpdateSchema);

  const existing = await prisma.recurringRule.findUnique({
    where: { id: input.id },
  });
  if (!existing) throw new ApiError(404, "That rule no longer exists.");

  const nextType = input.type ?? existing.type;

  // Merge the supplied keys into the stored template rather than replacing it.
  // Replacing meant any caller that did not round-trip every field silently
  // erased the rest — the salary calculator's stored working week, a payment
  // label, an original-currency pair. `undefined` is "not supplied"; an
  // explicit null still clears the field.
  let nextTemplate: Prisma.InputJsonObject | undefined;
  if (input.template !== undefined) {
    const stored = recurringTemplateSchema.safeParse(existing.templateJson);
    const merged: Record<string, unknown> = {
      ...(stored.success ? stored.data : {}),
    };
    for (const [key, value] of Object.entries(input.template)) {
      if (value !== undefined) merged[key] = value;
    }
    nextTemplate = merged as Prisma.InputJsonObject;
    await assertTemplateValid(
      (nextTemplate.categoryId as string | null | undefined) ?? null,
      nextType,
    );
  }

  const rule = await prisma.$transaction(async (tx) => {
    const updated = await tx.recurringRule.update({
      where: { id: input.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
        ...(input.nextRunDate !== undefined
          ? { nextRunDate: istDateToUtc(input.nextRunDate) }
          : {}),
        ...(input.autoApprove !== undefined ? { autoApprove: input.autoApprove } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(nextTemplate !== undefined ? { templateJson: nextTemplate } : {}),
      },
      include: withCount,
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.EDIT_RECURRING,
        entity: "RecurringRule",
        entityId: updated.id,
        before: {
          name: existing.name,
          isActive: existing.isActive,
          nextRunDate: existing.nextRunDate,
          autoApprove: existing.autoApprove,
          // Correcting an amount is the main reason to edit a rule, so it has
          // to be in the trail — otherwise the log says something changed
          // without saying what.
          template: existing.templateJson,
        },
        after: {
          name: updated.name,
          isActive: updated.isActive,
          nextRunDate: updated.nextRunDate,
          autoApprove: updated.autoApprove,
          template: updated.templateJson,
        },
      },
      tx,
    );
    return updated;
  });

  return jsonOk({ rule: await serializeRule(rule) });
});
