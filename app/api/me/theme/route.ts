import { jsonOk, parseJson, route } from "@/lib/api";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { themeSchema } from "@/lib/validation";

/** PATCH /api/me/theme — remember the user's dark/light choice (spec 4). */
export const PATCH = route(async (request: Request) => {
  const user = await requireUser();
  const { theme } = await parseJson(request, themeSchema);

  await prisma.user.update({
    where: { id: user.id },
    data: { themePref: theme },
  });

  return jsonOk({ theme });
});
