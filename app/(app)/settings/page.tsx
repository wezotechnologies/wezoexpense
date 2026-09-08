import type { Metadata } from "next";

import { SettingsManager } from "@/components/settings-manager";
import { PageHeader } from "@/components/ui/primitives";
import {
  env,
  isAiConfigured,
  isAzureConfigured,
  providerForModel,
} from "@/lib/env";
import { getAiBudget, getSettings } from "@/lib/settings";
import { requireCapability } from "@/lib/rbac";
import { storageMode } from "@/lib/storage";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireCapability("appSettings");

  const [settings, budget] = await Promise.all([getSettings(), getAiBudget()]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="How the books behave, and what this deployment has wired up."
      />

      <SettingsManager
        initial={{
          baseCurrency: settings.baseCurrency,
          aiModel: settings.aiModel,
          aiMonthlySpendCapUsd: settings.aiMonthlySpendCapUsd,
          approvalRequired: settings.approvalRequired,
          vatEnabled: settings.vatEnabled,
        }}
        meta={{
          ai: {
            configured: isAiConfigured(),
            providers: env.aiProviders,
            activeProvider: providerForModel(settings.aiModel),
            spentUsd: budget.spentUsd,
            remainingUsd: budget.remainingUsd,
            month: budget.month,
            exhausted: budget.exhausted,
          },
          storage: {
            mode: storageMode(),
            configured: isAzureConfigured(),
          },
          cronConfigured: env.cronSecret !== null,
        }}
      />
    </>
  );
}
