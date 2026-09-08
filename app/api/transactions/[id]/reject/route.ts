import { jsonOk, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import { rejectTransaction } from "@/lib/transactions";
import { rejectSchema } from "@/lib/validation";

/** POST /api/transactions/:id/reject — Admin+, reason required (spec 7.3). */
export const POST = route(
  async (
    request: Request,
    ctx: RouteContext<"/api/transactions/[id]/reject">,
  ) => {
    const user = await requireCapability("approve");
    const { id } = await ctx.params;
    const { reason } = await parseJson(request, rejectSchema);
    const txn = await rejectTransaction(user, id, reason);
    return jsonOk(txn);
  },
);
