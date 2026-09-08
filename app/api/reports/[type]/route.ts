import { jsonOk, parseQuery, route } from "@/lib/api";
import { ApiError, isAdminPlus, requireUser } from "@/lib/rbac";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { buildReport, type ReportType } from "@/lib/reports";
import { reportQuerySchema, reportTypeSchema } from "@/lib/validation";

/**
 * GET /api/reports/:type — report data as JSON (spec 12).
 *
 * Only Admin+ may run the full reports. An Employee is limited to their own
 * submission summary (spec 3, 10), and `buildReport` additionally scopes every
 * query to their own rows.
 */

export function assertReportAllowed(
  user: { role: "SUPERADMIN" | "ADMIN" | "EMPLOYEE" },
  type: ReportType,
): void {
  if (isAdminPlus(user)) return;
  if (type === "user-submissions") return;
  throw new ApiError(
    403,
    "Employees can only run their own submission summary.",
  );
}

export const GET = route(
  async (request: Request, ctx: RouteContext<"/api/reports/[type]">) => {
    const user = await requireUser();
    enforceRateLimit("report", user.id, LIMITS.report.limit, LIMITS.report.windowMs);

    const { type: rawType } = await ctx.params;
    const parsedType = reportTypeSchema.safeParse(rawType);
    if (!parsedType.success) {
      throw new ApiError(404, "That report does not exist.");
    }

    assertReportAllowed(user, parsedType.data);

    const query = parseQuery(request, reportQuerySchema);
    const report = await buildReport(user, parsedType.data, query);

    return jsonOk({ report });
  },
);
