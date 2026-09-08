import type { Metadata } from "next";

import { ChangePasswordForm } from "@/components/change-password-form";
import { Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/rbac";
import { formatDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Your account" };

const ROLE_LABEL: Record<string, string> = {
  SUPERADMIN: "Superadmin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
};

export default async function AccountPage() {
  const user = await requireUser();
  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { createdAt: true, _count: { select: { transactions: true } } },
  });

  return (
    <>
      <PageHeader
        title="Your account"
        description="Your details and password."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <dl className="divide-y divide-line text-sm">
            <Row label="Name" value={user.name} />
            <Row label="Email" value={user.email} />
            <Row label="Role" value={ROLE_LABEL[user.role] ?? user.role} />
            <Row
              label="Member since"
              value={record ? formatDate(record.createdAt) : "—"}
            />
            <Row
              label="Transactions submitted"
              value={String(record?._count.transactions ?? 0)}
            />
          </dl>
          <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
            Your name, email and role are managed by a Superadmin.
          </p>
        </Card>

        <Card>
          <CardHeader
            title="Change password"
            description="Use at least 10 characters, including a letter and a number."
          />
          <div className="p-4 sm:p-5">
            <ChangePasswordForm redirectTo="/account" />
          </div>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate text-right font-medium">{value}</dd>
    </div>
  );
}
