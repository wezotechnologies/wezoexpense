import { jsonOk, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import { lockPeriod } from "@/lib/periods";
import { periodSchema } from "@/lib/validation";

/** POST /api/periods/lock — Admin+ closes a month (spec 7.5). */
export const POST = route(async (request: Request) => {
  const user = await requireCapability("lockPeriod");
  const { month } = await parseJson(request, periodSchema);
  return jsonOk({ period: await lockPeriod(user, month) });
});
