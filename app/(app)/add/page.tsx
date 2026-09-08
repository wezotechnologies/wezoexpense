import type { Metadata } from "next";

import { AddFlow } from "@/components/add-flow";
import { PageHeader } from "@/components/ui/primitives";
import { isAiConfigured } from "@/lib/env";
import { getRefData } from "@/lib/refdata";
import { getSettings } from "@/lib/settings";
import { isAdminPlus, requireUser } from "@/lib/rbac";
import { todayDateKey } from "@/lib/dates";

export const metadata: Metadata = { title: "Add transaction" };

export default async function AddPage() {
  const user = await requireUser();
  const [refData, settings] = await Promise.all([getRefData(), getSettings()]);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Add a transaction"
        description="Capture a receipt and let AI read it, or type the details in yourself."
      />

      <AddFlow
        refData={refData}
        canApprove={isAdminPlus(user)}
        vatEnabled={settings.vatEnabled}
        approvalRequired={settings.approvalRequired}
        aiConfigured={isAiConfigured()}
        today={todayDateKey()}
      />
    </div>
  );
}
