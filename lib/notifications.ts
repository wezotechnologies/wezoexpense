import "server-only";

import { prisma } from "@/lib/prisma";
import { NotificationKind, Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

/**
 * In-app notification centre (spec 11).
 *
 * Email is left as a pluggable hook rather than wired to a provider: spec 11
 * marks it optional for v1. `deliverEmail` is the single seam — implement it
 * and every notification gains email delivery without touching callers.
 */

type NotifyInput = {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
};

export async function notify(
  input: NotifyInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;
  await db.notification.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    },
  });
  await deliverEmail(input);
}

export async function notifyMany(
  inputs: NotifyInput[],
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (inputs.length === 0) return;
  const db = tx ?? prisma;
  await db.notification.createMany({
    data: inputs.map((i) => ({
      userId: i.userId,
      kind: i.kind,
      title: i.title,
      body: i.body ?? null,
      link: i.link ?? null,
    })),
  });
  await Promise.all(inputs.map(deliverEmail));
}

/**
 * Notifies everyone who can act on an approval queue (spec 11: "new pending
 * submission (to approvers)"), optionally skipping the submitter.
 */
export async function notifyApprovers(
  input: Omit<NotifyInput, "userId">,
  exceptUserId?: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;
  const approvers = await db.user.findMany({
    where: {
      isActive: true,
      role: { in: [Role.SUPERADMIN, Role.ADMIN] },
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
    },
    select: { id: true },
  });

  await notifyMany(
    approvers.map((a) => ({ ...input, userId: a.id })),
    tx,
  );
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(
  userId: string,
  ids?: string[],
): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      readAt: null,
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  });
  return result.count;
}

/**
 * Email delivery seam (spec 11: "wire the hook, leave provider pluggable").
 * No provider is configured in v1, so this is intentionally a no-op.
 */
async function deliverEmail(input: NotifyInput): Promise<void> {
  // To enable: send via your provider here, using `input.userId`, `title` and
  // `body`. Failures must not break the in-app notification, so any
  // implementation should swallow its own errors.
  void input;
}
