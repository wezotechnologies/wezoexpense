import "server-only";

import { prisma } from "@/lib/prisma";
import { currentMonthKey } from "@/lib/dates";
import type { AppSetting } from "@/generated/prisma/client";

/**
 * AppSetting singleton accessor (spec 6, 16).
 * Creates the row on first read so a fresh database never 500s.
 */

export const SETTINGS_ID = "singleton";

export async function getSettings(): Promise<AppSetting> {
  const existing = await prisma.appSetting.findUnique({
    where: { id: SETTINGS_ID },
  });
  if (existing) return existing;

  return prisma.appSetting.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID },
  });
}

/**
 * Reads the AI spend counter, rolling it over when the month changes so the
 * cap is genuinely per-month rather than cumulative (spec 8.1).
 */
export async function getAiBudget(): Promise<{
  model: string;
  capUsd: number;
  spentUsd: number;
  month: string;
  remainingUsd: number;
  exhausted: boolean;
}> {
  const settings = await getSettings();
  const month = currentMonthKey();

  let spentUsd = settings.aiSpendThisMonthUsd;
  if (settings.aiSpendMonth !== month) {
    // New month — reset the running total before reporting it.
    const reset = await prisma.appSetting.update({
      where: { id: SETTINGS_ID },
      data: { aiSpendThisMonthUsd: 0, aiSpendMonth: month },
    });
    spentUsd = reset.aiSpendThisMonthUsd;
  }

  const capUsd = settings.aiMonthlySpendCapUsd;
  const remainingUsd = Math.max(0, capUsd - spentUsd);

  return {
    model: settings.aiModel,
    capUsd,
    spentUsd,
    month,
    remainingUsd,
    exhausted: spentUsd >= capUsd,
  };
}

/** Adds an estimated cost to this month's AI spend counter. */
export async function recordAiSpend(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const month = currentMonthKey();
  const settings = await getSettings();

  await prisma.appSetting.update({
    where: { id: SETTINGS_ID },
    data:
      settings.aiSpendMonth === month
        ? { aiSpendThisMonthUsd: { increment: usd } }
        : { aiSpendThisMonthUsd: usd, aiSpendMonth: month },
  });
}
