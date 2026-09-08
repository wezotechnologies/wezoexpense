import { z } from "zod";

import { jsonOk, parseQuery, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * GET /api/audit — searchable activity feed (spec 9.13, 12).
 * Admin reads; Superadmin also reads. The log is append-only: there is
 * deliberately no POST, PATCH or DELETE here.
 */

const query = z.object({
  action: z.string().max(60).optional(),
  entity: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
  actorId: z.string().max(64).optional(),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = route(async (request: Request) => {
  await requireCapability("viewAudit");
  const filter = parseQuery(request, query);

  const where: Prisma.AuditLogWhereInput = {
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.entity ? { entity: filter.entity } : {}),
    ...(filter.entityId ? { entityId: filter.entityId } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.q
      ? {
          OR: [
            { action: { contains: filter.q, mode: "insensitive" } },
            { entity: { contains: filter.q, mode: "insensitive" } },
            { entityId: { contains: filter.q, mode: "insensitive" } },
            { actor: { name: { contains: filter.q, mode: "insensitive" } } },
            { actor: { email: { contains: filter.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [total, entries] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.perPage,
      take: filter.perPage,
      include: { actor: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  return jsonOk({
    total,
    page: filter.page,
    perPage: filter.perPage,
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      actorId: e.actorId,
      actorName: e.actor?.name ?? "—",
      actorEmail: e.actor?.email ?? null,
      before: e.before,
      after: e.after,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});
