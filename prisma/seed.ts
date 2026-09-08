/**
 * Seed data (spec 16). Idempotent — safe to re-run.
 *
 *  - Superadmin from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD, flagged to change
 *    the password on first login.
 *  - Default income/expense categories, marked isSystem.
 *  - The AppSetting singleton.
 *
 * Runs standalone via `tsx`, so it builds its own PrismaClient instead of
 * importing lib/prisma.ts (which is guarded by `server-only`).
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { genSalt, hash } from "bcryptjs";

import { PrismaClient } from "../generated/prisma/client";
import { TxnType } from "../generated/prisma/enums";

const BCRYPT_COST = 12;

const INCOME_CATEGORIES = ["Client Work", "Retainer", "Other Income"];

const EXPENSE_CATEGORIES = [
  "Salaries",
  "Contractor/Freelancer",
  "Rent",
  "Utilities",
  "Software/Subscriptions",
  "Marketing/Ads",
  "Travel",
  "Office/Supplies",
  "Bank/Payment Fees",
  "Taxes",
  "Miscellaneous",
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    // ---- settings singleton -------------------------------------------
    const settings = await prisma.appSetting.upsert({
      where: { id: "singleton" },
      update: {},
      create: {
        id: "singleton",
        baseCurrency: "INR",
        aiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
        aiMonthlySpendCapUsd: 10,
        aiSpendThisMonthUsd: 0,
        approvalRequired: true,
        vatEnabled: true,
      },
    });
    console.log(
      `✓ settings: base=${settings.baseCurrency} model=${settings.aiModel} cap=$${settings.aiMonthlySpendCapUsd}`,
    );

    // ---- categories ----------------------------------------------------
    let created = 0;
    for (const name of INCOME_CATEGORIES) {
      const r = await prisma.category.upsert({
        where: { name_type: { name, type: TxnType.INCOME } },
        update: {},
        create: { name, type: TxnType.INCOME, isSystem: true },
      });
      if (r) created++;
    }
    for (const name of EXPENSE_CATEGORIES) {
      await prisma.category.upsert({
        where: { name_type: { name, type: TxnType.EXPENSE } },
        update: {},
        create: { name, type: TxnType.EXPENSE, isSystem: true },
      });
      created++;
    }
    console.log(
      `✓ categories: ${INCOME_CATEGORIES.length} income + ${EXPENSE_CATEGORIES.length} expense (${created} ensured)`,
    );

    // ---- superadmin ----------------------------------------------------
    const email = (process.env.SUPERADMIN_EMAIL || "").toLowerCase().trim();
    const password = process.env.SUPERADMIN_PASSWORD || "";
    const name = process.env.SUPERADMIN_NAME || "Wezo Superadmin";

    if (!email || !password) {
      console.warn(
        "! SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD not set — skipping Superadmin creation.",
      );
    } else {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        console.log(`✓ superadmin already exists: ${email} (password untouched)`);
      } else {
        const passwordHash = await hash(password, await genSalt(BCRYPT_COST));
        await prisma.user.create({
          data: {
            email,
            name,
            passwordHash,
            role: "SUPERADMIN",
            isActive: true,
            mustChangePassword: true, // forced change on first login
          },
        });
        console.log(`✓ superadmin created: ${email} (must change password on first login)`);
      }
    }

    const counts = {
      users: await prisma.user.count(),
      categories: await prisma.category.count(),
      transactions: await prisma.transaction.count(),
    };
    console.log("--- seed complete ---", counts);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
