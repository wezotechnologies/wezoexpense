import { jsonOk, parseJson, route } from "@/lib/api";
import { ApiError, requireCapability } from "@/lib/rbac";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { extractReceipt } from "@/lib/ai";
import { getReceiptBytes } from "@/lib/storage";
import { getAiBudget } from "@/lib/settings";
import { aiExtractSchema } from "@/lib/validation";

/**
 * POST /api/ai/extract — reads a stored receipt and returns a draft (spec 12).
 *
 * Always returns 200 with an outcome object: a failure to read the document is
 * a normal, expected result that routes the user to the manual form (spec 8.3),
 * not an HTTP error. Only genuine problems (missing file, rate limit) throw.
 */
export const POST = route(async (request: Request) => {
  const user = await requireCapability("useAi");
  enforceRateLimit(
    "ai",
    user.id,
    LIMITS.aiExtract.limit,
    LIMITS.aiExtract.windowMs,
  );

  const { blobKey, mime } = await parseJson(request, aiExtractSchema);

  const bytes = await getReceiptBytes(blobKey);
  if (!bytes) {
    throw new ApiError(404, "That upload could not be found. Please try again.");
  }

  const outcome = await extractReceipt(bytes, mime);
  const budget = await getAiBudget();

  return jsonOk({
    ok: outcome.ok,
    band: outcome.band,
    draft: outcome.draft,
    notice: outcome.notice,
    raw: outcome.raw,
    aiConfidence: outcome.draft?.confidence ?? null,
    budget: {
      capUsd: budget.capUsd,
      spentUsd: Number(budget.spentUsd.toFixed(4)),
      remainingUsd: Number(budget.remainingUsd.toFixed(4)),
      exhausted: budget.exhausted,
    },
  });
});
