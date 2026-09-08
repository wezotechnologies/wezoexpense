import { jsonCreated, jsonOk, parseJson, parseQuery, route } from "@/lib/api";
import { ApiError, requireCapability, requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { categoryCreateSchema, categoryUpdateSchema, txnTypeSchema } from "@/lib/validation";
import { z } from "zod";

/**
 * Categories (spec 12). Reading is open to any signed-in user because the Add
 * form needs the list; writing is Admin+.
 */

const listQuery = z.object({
  type: txnTypeSchema.optional(),
  includeInactive: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export const GET = route(async (request: Request) => {
  await requireUser();
  const { type, includeInactive } = parseQuery(request, listQuery);

  const categories = await prisma.category.findMany({
    where: {
      ...(type ? { type } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      type: true,
      isActive: true,
      isSystem: true,
    },
  });

  return jsonOk({ categories });
});

export const POST = route(async (request: Request) => {
  const user = await requireCapability("manageDirectories");
  const input = await parseJson(request, categoryCreateSchema);

  const existing = await prisma.category.findUnique({
    where: { name_type: { name: input.name, type: input.type } },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, `A ${input.type.toLowerCase()} category called "${input.name}" already exists.`);
  }

  const category = await prisma.$transaction(async (tx) => {
    const created = await tx.category.create({
      data: { name: input.name, type: input.type },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.CREATE_CATEGORY,
        entity: "Category",
        entityId: created.id,
        after: { name: created.name, type: created.type },
      },
      tx,
    );
    return created;
  });

  return jsonCreated({ category });
});

export const PATCH = route(async (request: Request) => {
  const user = await requireCapability("manageDirectories");
  const input = await parseJson(request, categoryUpdateSchema);

  const existing = await prisma.category.findUnique({ where: { id: input.id } });
  if (!existing) throw new ApiError(404, "That category no longer exists.");

  // Renaming must not collide with another category on the same side.
  if (input.name && input.name !== existing.name) {
    const clash = await prisma.category.findUnique({
      where: { name_type: { name: input.name, type: existing.type } },
      select: { id: true },
    });
    if (clash) {
      throw new ApiError(409, `A ${existing.type.toLowerCase()} category called "${input.name}" already exists.`);
    }
  }

  // Seeded categories can be deactivated but not renamed, so historical
  // reports keep meaning what they said.
  if (existing.isSystem && input.name && input.name !== existing.name) {
    throw new ApiError(
      422,
      "Default categories can't be renamed. Deactivate it and add your own instead.",
    );
  }

  const category = await prisma.$transaction(async (tx) => {
    const updated = await tx.category.update({
      where: { id: input.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.EDIT_CATEGORY,
        entity: "Category",
        entityId: updated.id,
        before: { name: existing.name, isActive: existing.isActive },
        after: { name: updated.name, isActive: updated.isActive },
      },
      tx,
    );
    return updated;
  });

  return jsonOk({ category });
});
