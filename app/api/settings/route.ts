import { jsonOk, parseJson, route } from "@/lib/api";
import { requireCapability, requireUser, isAdminPlus } from "@/lib/rbac";
import { ApiError } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { getAiBudget, getSettings, SETTINGS_ID } from "@/lib/settings";
import {
  env,
  isAiConfigured,
  isAzureConfigured,
  providerForModel,
} from "@/lib/env";
import { storageMode } from "@/lib/storage";
import { settingsSchema } from "@/lib/validation";

/**
 * GET   /api/settings — Admin+ may read (the Add form needs approvalRequired
 *                       and vatEnabled to decide what to show).
 * PATCH /api/settings — Superadmin only (spec 3).
 */

export const GET = route(async () => {
  const user = await requireUser();
  if (!isAdminPlus(user)) throw new ApiError(403, "You do not have access to this.");

  const settings = await getSettings();
  const budget = await getAiBudget();

  return jsonOk({
    settings: {
      baseCurrency: settings.baseCurrency,
      aiModel: settings.aiModel,
      aiMonthlySpendCapUsd: settings.aiMonthlySpendCapUsd,
      approvalRequired: settings.approvalRequired,
      vatEnabled: settings.vatEnabled,
    },
    ai: {
      configured: isAiConfigured(),
      providers: env.aiProviders,
      activeProvider: providerForModel(settings.aiModel),
      spentUsd: Number(budget.spentUsd.toFixed(4)),
      remainingUsd: Number(budget.remainingUsd.toFixed(4)),
      month: budget.month,
      exhausted: budget.exhausted,
    },
    storage: {
      mode: storageMode(),
      configured: isAzureConfigured(),
    },
  });
});

export const PATCH = route(async (request: Request) => {
  const user = await requireCapability("appSettings");
  const input = await parseJson(request, settingsSchema);

  const before = await getSettings();

  const updated = await prisma.$transaction(async (tx) => {
    const settings = await tx.appSetting.update({
      where: { id: SETTINGS_ID },
      data: {
        ...(input.baseCurrency !== undefined ? { baseCurrency: input.baseCurrency } : {}),
        ...(input.aiModel !== undefined ? { aiModel: input.aiModel } : {}),
        ...(input.aiMonthlySpendCapUsd !== undefined
          ? { aiMonthlySpendCapUsd: input.aiMonthlySpendCapUsd }
          : {}),
        ...(input.approvalRequired !== undefined
          ? { approvalRequired: input.approvalRequired }
          : {}),
        ...(input.vatEnabled !== undefined ? { vatEnabled: input.vatEnabled } : {}),
      },
    });

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.EDIT_SETTINGS,
        entity: "AppSetting",
        entityId: SETTINGS_ID,
        before: {
          baseCurrency: before.baseCurrency,
          aiModel: before.aiModel,
          aiMonthlySpendCapUsd: before.aiMonthlySpendCapUsd,
          approvalRequired: before.approvalRequired,
          vatEnabled: before.vatEnabled,
        },
        after: {
          baseCurrency: settings.baseCurrency,
          aiModel: settings.aiModel,
          aiMonthlySpendCapUsd: settings.aiMonthlySpendCapUsd,
          approvalRequired: settings.approvalRequired,
          vatEnabled: settings.vatEnabled,
        },
      },
      tx,
    );

    return settings;
  });

  return jsonOk({
    settings: {
      baseCurrency: updated.baseCurrency,
      aiModel: updated.aiModel,
      aiMonthlySpendCapUsd: updated.aiMonthlySpendCapUsd,
      approvalRequired: updated.approvalRequired,
      vatEnabled: updated.vatEnabled,
    },
  });
});
