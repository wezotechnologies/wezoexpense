import { z } from "zod";

import { jsonOk, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/rbac";
import { commitImport, previewImport } from "@/lib/import";

/**
 * POST /api/import — bulk CSV import (spec 11). Admin+ only.
 *
 * `mode: "preview"` validates and reports; `mode: "commit"` writes. Commit
 * re-parses and re-validates the same CSV text server-side, so a tampered
 * preview cannot be used to bypass a period lock or a validation rule.
 */

const schema = z.object({
  mode: z.enum(["preview", "commit"]),
  csv: z
    .string()
    .min(1, { error: "Paste or upload a CSV first." })
    .max(4_000_000, { error: "That file is too large. Split it into smaller files." }),
  approve: z.boolean().default(false),
  createMissingVendors: z.boolean().default(true),
});

export const POST = route(async (request: Request) => {
  const user = await requireCapability("importCsv");
  const input = await parseJson(request, schema);

  if (input.mode === "preview") {
    return jsonOk({ preview: await previewImport(input.csv) });
  }

  const result = await commitImport(user, input.csv, {
    approve: input.approve,
    createMissingVendors: input.createMissingVendors,
  });

  return jsonOk({ result });
});
