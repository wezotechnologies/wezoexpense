import { jsonCreated, jsonOk, parseJson, route } from "@/lib/api";
import { ApiError, requireCapability, requireUser, isAdminPlus } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/passwords";
import { userCreateSchema, userUpdateSchema } from "@/lib/validation";
import { Role } from "@/generated/prisma/enums";

/**
 * Users (spec 3, 12).
 *
 * Listing is Admin+ (they need names for the "created by" filter and the
 * per-user report). Creating, deactivating, changing roles and resetting
 * passwords are Superadmin only.
 */

export const GET = route(async () => {
  const user = await requireUser();
  if (!isAdminPlus(user)) throw new ApiError(403, "You do not have access to this.");

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

  return jsonOk({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt.toISOString(),
      submissionCount: u._count.transactions,
    })),
  });
});

export const POST = route(async (request: Request) => {
  const actor = await requireCapability("manageUsers");
  const input = await parseJson(request, userCreateSchema);

  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, "Someone with that email address already exists.");
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        role: input.role,
        passwordHash: await hashPassword(input.password),
        // The Superadmin picks the first password, so make the new user
        // replace it with one only they know.
        mustChangePassword: true,
      },
    });
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ADD_USER,
        entity: "User",
        entityId: user.id,
        after: { name: user.name, email: user.email, role: user.role },
      },
      tx,
    );
    return user;
  });

  return jsonCreated({
    user: {
      id: created.id,
      name: created.name,
      email: created.email,
      role: created.role,
      isActive: created.isActive,
    },
  });
});

export const PATCH = route(async (request: Request) => {
  const actor = await requireCapability("manageUsers");
  const input = await parseJson(request, userUpdateSchema);

  const target = await prisma.user.findUnique({ where: { id: input.id } });
  if (!target) throw new ApiError(404, "That user no longer exists.");

  // Guard rails so the instance can't be locked out of its own admin.
  if (target.id === actor.id) {
    if (input.role && input.role !== target.role) {
      throw new ApiError(422, "You can't change your own role.");
    }
    if (input.isActive === false) {
      throw new ApiError(422, "You can't deactivate your own account.");
    }
  }

  if (
    target.role === Role.SUPERADMIN &&
    (input.role === Role.ADMIN || input.role === Role.EMPLOYEE || input.isActive === false)
  ) {
    const otherSuperadmins = await prisma.user.count({
      where: { role: Role.SUPERADMIN, isActive: true, id: { not: target.id } },
    });
    if (otherSuperadmins === 0) {
      throw new ApiError(
        422,
        "This is the only active Superadmin. Promote someone else first.",
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: input.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.newPassword
          ? {
              passwordHash: await hashPassword(input.newPassword),
              mustChangePassword: true,
            }
          : {}),
      },
    });

    // One call can do several things; log each separately so the audit trail
    // reads as what actually happened rather than a generic "edit".
    if (input.role !== undefined && input.role !== target.role) {
      await recordAudit(
        {
          actorId: actor.id,
          action: AuditAction.CHANGE_ROLE,
          entity: "User",
          entityId: user.id,
          before: { role: target.role },
          after: { role: user.role },
        },
        tx,
      );
    }
    if (input.isActive !== undefined && input.isActive !== target.isActive) {
      await recordAudit(
        {
          actorId: actor.id,
          action: input.isActive
            ? AuditAction.REACTIVATE_USER
            : AuditAction.DEACTIVATE_USER,
          entity: "User",
          entityId: user.id,
          before: { isActive: target.isActive },
          after: { isActive: user.isActive },
        },
        tx,
      );
    }
    if (input.newPassword) {
      await recordAudit(
        {
          actorId: actor.id,
          action: AuditAction.RESET_PASSWORD,
          entity: "User",
          entityId: user.id,
          after: { email: user.email },
        },
        tx,
      );
    }
    if (input.name !== undefined && input.name !== target.name) {
      await recordAudit(
        {
          actorId: actor.id,
          action: AuditAction.EDIT_USER,
          entity: "User",
          entityId: user.id,
          before: { name: target.name },
          after: { name: user.name },
        },
        tx,
      );
    }

    return user;
  });

  return jsonOk({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      isActive: updated.isActive,
    },
  });
});
