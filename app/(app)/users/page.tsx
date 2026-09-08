import type { Metadata } from "next";

import { UsersManager } from "@/components/users-manager";
import { PageHeader } from "@/components/ui/primitives";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/rbac";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const user = await requireCapability("manageUsers");

  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      createdAt: true,
      _count: { select: { transactions: true } },
    },
  });

  return (
    <>
      <PageHeader
        title="Users"
        description="Add colleagues, set what they can do, and reset passwords. Every change is logged."
      />

      <UsersManager
        currentUserId={user.id}
        users={users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          isActive: u.isActive,
          mustChangePassword: u.mustChangePassword,
          createdAt: u.createdAt.toISOString(),
          submissionCount: u._count.transactions,
        }))}
      />
    </>
  );
}
