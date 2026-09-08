import { timingSafeEqual } from "node:crypto";

import { jsonOk, route } from "@/lib/api";
import { ApiError, getSessionUser, isAdminPlus } from "@/lib/rbac";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { runDueRules } from "@/lib/recurring";
import { Role } from "@/generated/prisma/enums";

/**
 * POST /api/cron/recurring — generates due recurring transactions (spec 7.4).
 *
 * Two accepted callers:
 *  1. The scheduler, with `Authorization: Bearer <CRON_SECRET>`.
 *  2. A signed-in Admin+, so the run can be triggered by hand from the
 *     Recurring screen.
 *
 * When the scheduler calls, there is no session, so the run is attributed to
 * the oldest active Superadmin — the audit trail always names a real user.
 */

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function resolveActor(request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const secret = env.cronSecret;

  if (secret && header.startsWith("Bearer ")) {
    const presented = header.slice("Bearer ".length).trim();
    if (constantTimeEquals(presented, secret)) {
      const systemActor = await prisma.user.findFirst({
        where: { role: Role.SUPERADMIN, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!systemActor) {
        throw new ApiError(500, "No active Superadmin to attribute the run to.");
      }
      return systemActor.id;
    }
    throw new ApiError(401, "Invalid cron credentials.");
  }

  const user = await getSessionUser();
  if (user && isAdminPlus(user)) return user.id;

  throw new ApiError(401, "This endpoint requires cron credentials or an admin session.");
}

export const POST = route(async (request: Request) => {
  const actorId = await resolveActor(request);
  const report = await runDueRules(actorId);
  return jsonOk({ report });
});

/** Some schedulers only issue GETs; behave identically. */
export const GET = POST;
