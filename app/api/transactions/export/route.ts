import { parseQuery, route } from "@/lib/api";
import { requireUser } from "@/lib/rbac";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { csvResponse, exportFilename, transactionsToCsv } from "@/lib/csv";
import { listTransactions } from "@/lib/transactions";
import { transactionFilterSchema } from "@/lib/validation";

/**
 * GET /api/transactions/export — CSV of the current filter (spec 9.4).
 *
 * Uses the same role-scoped query as the list, so an Employee's export contains
 * only their own rows.
 */
export const GET = route(async (request: Request) => {
  const user = await requireUser();
  enforceRateLimit("report", user.id, LIMITS.report.limit, LIMITS.report.windowMs);

  const filter = parseQuery(request, transactionFilterSchema);
  // Export the whole filter, not just the page the user is looking at.
  const { rows } = await listTransactions(user, {
    ...filter,
    page: 1,
    perPage: 5000,
  });

  return csvResponse(
    transactionsToCsv(rows),
    exportFilename("transactions", "csv"),
  );
});
