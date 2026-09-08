import type { Metadata } from "next";
import { Suspense } from "react";

import { DirectoriesManager } from "@/components/directories-manager";
import { PageHeader } from "@/components/ui/primitives";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/rbac";

export const metadata: Metadata = { title: "Categories & vendors" };

export default async function DirectoriesPage() {
  await requireCapability("manageDirectories");

  const [categories, vendors, projects] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, isActive: true, isSystem: true },
    }),
    prisma.vendor.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        notes: true,
        isActive: true,
        _count: { select: { transactions: true } },
      },
    }),
    prisma.project.findMany({
      orderBy: { name: "asc" },
      include: { client: { select: { name: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Categories & vendors"
        description="The lists that classify every transaction. Deactivating keeps history intact but hides an entry from new work."
      />

      <Suspense fallback={null}>
        <DirectoriesManager
          categories={categories}
          vendors={vendors.map((v) => ({
            id: v.id,
            name: v.name,
            kind: v.kind,
            notes: v.notes,
            isActive: v.isActive,
            transactionCount: v._count.transactions,
          }))}
          projects={projects.map((p) => ({
            id: p.id,
            name: p.name,
            clientId: p.clientId,
            clientName: p.client?.name ?? null,
            isActive: p.isActive,
          }))}
        />
      </Suspense>
    </>
  );
}
