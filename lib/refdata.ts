import "server-only";

import { prisma } from "@/lib/prisma";
import type { RefData } from "@/components/transaction-form";

/**
 * Reference lists the transaction form needs (categories, vendors, projects).
 * Only active rows, so a retired category can't be picked for new work while
 * old transactions keep theirs.
 */
export async function getRefData(): Promise<RefData> {
  const [categories, vendors, projects] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    prisma.vendor.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, kind: true },
    }),
    prisma.project.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, clientId: true },
    }),
  ]);

  return { categories, vendors, projects };
}
