import { z } from "zod";

import { jsonOk, parseJson, parseQuery, route } from "@/lib/api";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { markRead } from "@/lib/notifications";

/**
 * GET   /api/notifications — the caller's own feed (spec 12).
 * PATCH /api/notifications — mark some or all as read.
 *
 * Scoped to `userId` in every query, so one user can never read another's.
 */

const listQuery = z.object({
  unreadOnly: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const GET = route(async (request: Request) => {
  const user = await requireUser();
  const { unreadOnly, limit } = parseQuery(request, listQuery);

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: user.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  return jsonOk({
    unread,
    notifications: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      // Strip the internal de-duplication marker used by budget alerts.
      body: n.body ? n.body.replace(/\s*\[budget:[^\]]+\]\s*$/, "") : null,
      link: n.link,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
  });
});

export const PATCH = route(async (request: Request) => {
  const user = await requireUser();
  const { ids } = await parseJson(
    request,
    z.object({ ids: z.array(z.string().min(1).max(64)).max(200).optional() }),
  );

  const count = await markRead(user.id, ids);
  return jsonOk({ marked: count });
});
