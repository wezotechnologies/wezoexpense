import type { Metadata } from "next";
import { Suspense } from "react";

import { Alert, PageHeader } from "@/components/ui/primitives";
import { ReportBody, ReportControls } from "@/components/report-view";
import { buildReport, resolveRange, type ReportType } from "@/lib/reports";
import { isAdminPlus, requireUser } from "@/lib/rbac";
import { reportQuerySchema, reportTypeSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Reports" };

const ADMIN_TYPES: ReportType[] = [
  "pnl",
  "expenses-by-category",
  "expenses-by-vendor",
  "income-summary",
  "cash-flow",
  "budget-vs-actual",
  "user-submissions",
];

/** Employees get only their own submission summary (spec 3, 10). */
const EMPLOYEE_TYPES: ReportType[] = ["user-submissions"];

export default async function ReportsPage(props: PageProps<"/reports">) {
  const user = await requireUser();
  const searchParams = await props.searchParams;
  const admin = isAdminPlus(user);
  const allowed = admin ? ADMIN_TYPES : EMPLOYEE_TYPES;

  const requested = reportTypeSchema.safeParse(searchParams.type);
  const type: ReportType =
    requested.success && allowed.includes(requested.data)
      ? requested.data
      : allowed[0];

  const parsedQuery = reportQuerySchema.safeParse(searchParams);
  const query = parsedQuery.success ? parsedQuery.data : reportQuerySchema.parse({});

  const report = await buildReport(user, type, query);
  const range = resolveRange(query);

  // The export links are this exact view plus a format.
  const exportParams = new URLSearchParams();
  if (query.month) exportParams.set("month", query.month);
  else {
    exportParams.set("from", range.from);
    exportParams.set("to", range.to);
  }
  if (query.status) exportParams.set("status", query.status);
  if (query.categoryId) exportParams.set("categoryId", query.categoryId);
  if (query.vendorId) exportParams.set("vendorId", query.vendorId);
  if (query.createdById) exportParams.set("createdById", query.createdById);

  return (
    <>
      <PageHeader
        title="Reports"
        description={
          admin
            ? "Cash-basis reports on approved transactions, in INR. Export any view to PDF or CSV."
            : "A summary of everything you have submitted."
        }
      />

      {!admin ? (
        <Alert tone="info" className="mb-4">
          You can see and export your own submission summary. Company-wide reports
          are available to admins.
        </Alert>
      ) : null}

      <Suspense fallback={null}>
        <ReportControls
          type={type}
          from={query.month ? "" : range.from}
          to={query.month ? "" : range.to}
          month={query.month ?? range.from.slice(0, 7)}
          allowedTypes={allowed}
        />
      </Suspense>

      <ReportBody report={report} exportQuery={exportParams.toString()} />
    </>
  );
}
