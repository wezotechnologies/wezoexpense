import { jsonCreated, jsonOk, parseJson, parseQuery, route } from "@/lib/api";
import { requireUser } from "@/lib/rbac";
import { createTransaction, listTransactions } from "@/lib/transactions";
import {
  createTransactionSchema,
  transactionFilterSchema,
} from "@/lib/validation";

/**
 * GET  /api/transactions — list, filtered and role-scoped (spec 12).
 * POST /api/transactions — create; status is decided server-side (spec 7.1).
 */

export const GET = route(async (request: Request) => {
  const user = await requireUser();
  const filter = parseQuery(request, transactionFilterSchema);
  const result = await listTransactions(user, filter);
  return jsonOk(result);
});

export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const input = await parseJson(request, createTransactionSchema);
  const txn = await createTransaction(user, input);
  return jsonCreated(txn);
});
