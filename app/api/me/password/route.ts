import { jsonOk, parseJson, route } from "@/lib/api";
import { ApiError, requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { AuditAction, recordAudit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import { changeOwnPasswordSchema } from "@/lib/validation";

/**
 * PATCH /api/me/password — change your own password.
 * Used both for a voluntary change and to satisfy the forced change on first
 * login (spec 16).
 */
export const PATCH = route(async (request: Request) => {
  const user = await requireUser();
  const input = await parseJson(request, changeOwnPasswordSchema);

  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!record) throw new ApiError(404, "Your account could not be found.");

  const ok = await verifyPassword(input.currentPassword, record.passwordHash);
  if (!ok) throw new ApiError(422, "Your current password is incorrect.");

  if (await verifyPassword(input.newPassword, record.passwordHash)) {
    throw new ApiError(422, "Choose a password you haven't used before.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        mustChangePassword: false,
      },
    });
    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.CHANGE_OWN_PASSWORD,
        entity: "User",
        entityId: user.id,
      },
      tx,
    );
  });

  return jsonOk({ ok: true });
});
