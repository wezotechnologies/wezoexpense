import type { Metadata } from "next";

import { PeriodClose } from "@/components/period-close";
import { Alert, PageHeader } from "@/components/ui/primitives";
import { addMonths, currentMonthKey } from "@/lib/dates";
import { recentPeriods } from "@/lib/periods";
import { isSuperadmin, requireCapability } from "@/lib/rbac";

export const metadata: Metadata = { title: "Monthly close" };

const MONTHS_SHOWN = 12;

export default async function ClosePage() {
  const user = await requireCapability("lockPeriod");

  const current = currentMonthKey();
  const months = Array.from({ length: MONTHS_SHOWN }, (_, i) =>
    addMonths(current, -i),
  );
  const periods = await recentPeriods(months);

  return (
    <>
      <PageHeader
        title="Monthly close"
        description="Lock a month once its books are final, so nothing can be changed after the fact."
      />

      <Alert tone="info" className="mb-4">
        Closing a month sets every transaction dated in it to read-only. Admins
        can close a month; only a Superadmin can reopen one. Both actions are
        recorded in the audit log.
      </Alert>

      <PeriodClose periods={periods} canUnlock={isSuperadmin(user)} />
    </>
  );
}
