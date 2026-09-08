import { z } from "zod";

import { jsonCreated, jsonOk, parseJson, parseQuery, route } from "@/lib/api";
import { ApiError, requireCapability, requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { projectCreateSchema, projectUpdateSchema } from "@/lib/validation";

/** Projects — optional grouping for client work (spec 6, 12). */

const listQuery = z.object({
  clientId: z.string().max(64).optional(),
  includeInactive: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export const GET = route(async (request: Request) => {
  await requireUser();
  const { clientId, includeInactive } = parseQuery(request, listQuery);

  const projects = await prisma.project.findMany({
    where: {
      ...(clientId ? { clientId } : {}),
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: { name: "asc" },
    include: { client: { select: { id: true, name: true } } },
  });

  return jsonOk({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      clientId: p.clientId,
      clientName: p.client?.name ?? null,
      isActive: p.isActive,
    })),
  });
});

export const POST = route(async (request: Request) => {
  const user = await requireCapability("manageDirectories");
  const input = await parseJson(request, projectCreateSchema);

  if (input.clientId) {
    const client = await prisma.vendor.findUnique({
      where: { id: input.clientId },
      select: { id: true },
    });
    if (!client) throw new ApiError(422, "That client no longer exists.");
  }

  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: { name: input.name, clientId: input.clientId },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.CREATE_PROJECT,
        entity: "Project",
        entityId: created.id,
        after: { name: created.name, clientId: created.clientId },
      },
      tx,
    );
    return created;
  });

  return jsonCreated({ project });
});

export const PATCH = route(async (request: Request) => {
  const user = await requireCapability("manageDirectories");
  const input = await parseJson(request, projectUpdateSchema);

  const existing = await prisma.project.findUnique({ where: { id: input.id } });
  if (!existing) throw new ApiError(404, "That project no longer exists.");

  if (input.clientId) {
    const client = await prisma.vendor.findUnique({
      where: { id: input.clientId },
      select: { id: true },
    });
    if (!client) throw new ApiError(422, "That client no longer exists.");
  }

  const project = await prisma.$transaction(async (tx) => {
    const updated = await tx.project.update({
      where: { id: input.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.EDIT_PROJECT,
        entity: "Project",
        entityId: updated.id,
        before: { name: existing.name, clientId: existing.clientId, isActive: existing.isActive },
        after: { name: updated.name, clientId: updated.clientId, isActive: updated.isActive },
      },
      tx,
    );
    return updated;
  });

  return jsonOk({ project });
});
