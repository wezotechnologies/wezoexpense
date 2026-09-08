import { jsonOk, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import { approveTransaction } from "@/lib/transactions";

/** POST /api/transactions/:id/approve — Admin+ (spec 7.3). */
export const POST = route(
  async (
    _request: Request,
    ctx: RouteContext<"/api/transactions/[id]/approve">,
  ) => {
    const user = await requireCapability("approve");
    const { id } = await ctx.params;
    const txn = await approveTransaction(user, id);
    return jsonOk(txn);
  },
);
