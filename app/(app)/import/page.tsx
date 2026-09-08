import type { Metadata } from "next";

import { ImportWizard } from "@/components/import-wizard";
import { PageHeader } from "@/components/ui/primitives";
import { requireCapability } from "@/lib/rbac";

export const metadata: Metadata = { title: "Import CSV" };

export default async function ImportPage() {
  await requireCapability("importCsv");

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Import from CSV"
        description="Bring historical transactions in. Every row is checked and shown to you before anything is saved."
      />
      <ImportWizard />
    </div>
  );
}
