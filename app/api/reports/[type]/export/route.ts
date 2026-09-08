import { parseQuery, route } from "@/lib/api";
import { ApiError, requireUser } from "@/lib/rbac";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { csvResponse, exportFilename, reportToCsv } from "@/lib/csv";
import { pdfResponse, reportToPdf } from "@/lib/pdf";
import { buildReport } from "@/lib/reports";
import { reportQuerySchema, reportTypeSchema } from "@/lib/validation";
import { assertReportAllowed } from "../route";

/**
 * GET /api/reports/:type/export?fmt=pdf|csv (spec 10, 12).
 * Same authorisation as the JSON route: Employees may export only their own
 * submission summary.
 */
export const GET = route(
  async (request: Request, ctx: RouteContext<"/api/reports/[type]/export">) => {
    const user = await requireUser();
    enforceRateLimit("report", user.id, LIMITS.report.limit, LIMITS.report.windowMs);

    const { type: rawType } = await ctx.params;
    const parsedType = reportTypeSchema.safeParse(rawType);
    if (!parsedType.success) {
      throw new ApiError(404, "That report does not exist.");
    }

    assertReportAllowed(user, parsedType.data);

    const query = parseQuery(request, reportQuerySchema);
    const format = query.fmt ?? "csv";

    const report = await buildReport(user, parsedType.data, query);
    const filename = exportFilename(report.title, format, report.periodLabel);

    if (format === "pdf") {
      return pdfResponse(await reportToPdf(report), filename);
    }
    return csvResponse(reportToCsv(report), filename);
  },
);
