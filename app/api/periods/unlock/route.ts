import { jsonOk, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import { unlockPeriod } from "@/lib/periods";
import { periodSchema } from "@/lib/validation";

/** POST /api/periods/unlock — Superadmin only (spec 3, 7.5). */
export const POST = route(async (request: Request) => {
  const user = await requireCapability("unlockPeriod");
  const { month } = await parseJson(request, periodSchema);
  return jsonOk({ period: await unlockPeriod(user, month) });
});
