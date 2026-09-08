import { jsonOk, parseJson, route } from "@/lib/api";
import { ApiError, requireUser, assertCan } from "@/lib/rbac";
import {
  getTransaction,
  serializeTransaction,
  softDeleteTransaction,
  updateTransaction,
} from "@/lib/transactions";
import { updateTransactionSchema } from "@/lib/validation";

/**
 * GET    /api/transactions/:id — scoped read.
 * PATCH  /api/transactions/:id — Admin+, or own-if-pending (spec 12).
 * DELETE /api/transactions/:id — Admin+, soft delete (spec 14).
 */

export const GET = route(
  async (_request: Request, ctx: RouteContext<"/api/transactions/[id]">) => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const txn = await getTransaction(user, id);
    // Same response whether it is missing or simply not this user's, so the
    // endpoint can't be used to probe for other people's transactions.
    if (!txn) throw new ApiError(404, "That transaction no longer exists.");

    return jsonOk(serializeTransaction(txn));
  },
);

export const PATCH = route(
  async (request: Request, ctx: RouteContext<"/api/transactions/[id]">) => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const input = await parseJson(request, updateTransactionSchema);
    const txn = await updateTransaction(user, id, input);
    return jsonOk(txn);
  },
);

export const DELETE = route(
  async (_request: Request, ctx: RouteContext<"/api/transactions/[id]">) => {
    const user = await requireUser();
    assertCan(user, "deleteTransaction");
    const { id } = await ctx.params;
    await softDeleteTransaction(user, id);
    return jsonOk({ ok: true });
  },
);
