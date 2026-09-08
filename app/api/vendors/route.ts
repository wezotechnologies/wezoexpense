import { z } from "zod";

import { jsonCreated, jsonOk, parseJson, parseQuery, route } from "@/lib/api";
import { ApiError, requireCapability, requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { vendorCreateSchema, vendorKindSchema, vendorUpdateSchema } from "@/lib/validation";

/** Vendors & clients directory (spec 11, 12). Read: any user. Write: Admin+. */

const listQuery = z.object({
  kind: vendorKindSchema.optional(),
  q: z.string().max(120).optional(),
  includeInactive: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export const GET = route(async (request: Request) => {
  await requireUser();
  const { kind, q, includeInactive } = parseQuery(request, listQuery);

  const vendors = await prisma.vendor.findMany({
    where: {
      ...(kind ? { kind } : {}),
      ...(includeInactive ? {} : { isActive: true }),
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      kind: true,
      notes: true,
      isActive: true,
      _count: { select: { transactions: true } },
    },
  });

  return jsonOk({
    vendors: vendors.map((v) => ({
      id: v.id,
      name: v.name,
      kind: v.kind,
      notes: v.notes,
      isActive: v.isActive,
      transactionCount: v._count.transactions,
    })),
  });
});

export const POST = route(async (request: Request) => {
  const user = await requireCapability("manageDirectories");
  const input = await parseJson(request, vendorCreateSchema);

  const existing = await prisma.vendor.findUnique({
    where: { name: input.name },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, `"${input.name}" is already in the directory.`);
  }

  const vendor = await prisma.$transaction(async (tx) => {
    const created = await tx.vendor.create({
      data: { name: input.name, kind: input.kind, notes: input.notes },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.CREATE_VENDOR,
        entity: "Vendor",
        entityId: created.id,
        after: { name: created.name, kind: created.kind },
      },
      tx,
    );
    return created;
  });

  return jsonCreated({ vendor });
});

export const PATCH = route(async (request: Request) => {
  const user = await requireCapability("manageDirectories");
  const input = await parseJson(request, vendorUpdateSchema);

  const existing = await prisma.vendor.findUnique({ where: { id: input.id } });
  if (!existing) throw new ApiError(404, "That entry no longer exists.");

  if (input.name && input.name !== existing.name) {
    const clash = await prisma.vendor.findUnique({
      where: { name: input.name },
      select: { id: true },
    });
    if (clash) throw new ApiError(409, `"${input.name}" is already in the directory.`);
  }

  const vendor = await prisma.$transaction(async (tx) => {
    const updated = await tx.vendor.update({
      where: { id: input.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        // `undefined` leaves notes alone; explicit null clears them.
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.EDIT_VENDOR,
        entity: "Vendor",
        entityId: updated.id,
        before: { name: existing.name, kind: existing.kind, isActive: existing.isActive },
        after: { name: updated.name, kind: updated.kind, isActive: updated.isActive },
      },
      tx,
    );
    return updated;
  });

  return jsonOk({ vendor });
});
