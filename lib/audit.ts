import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Append-only audit trail (spec 11, 14). Every mutating route writes here.
 * Nothing in the app ever updates or deletes an AuditLog row.
 */

export const AuditAction = {
  // transactions
  CREATE_TXN: "CREATE_TXN",
  EDIT_TXN: "EDIT_TXN",
  APPROVE_TXN: "APPROVE_TXN",
  REJECT_TXN: "REJECT_TXN",
  DELETE_TXN: "DELETE_TXN",
  IMPORT_TXN: "IMPORT_TXN",
  // directories
  CREATE_CATEGORY: "CREATE_CATEGORY",
  EDIT_CATEGORY: "EDIT_CATEGORY",
  CREATE_VENDOR: "CREATE_VENDOR",
  EDIT_VENDOR: "EDIT_VENDOR",
  CREATE_PROJECT: "CREATE_PROJECT",
  EDIT_PROJECT: "EDIT_PROJECT",
  // recurring & budgets
  CREATE_RECURRING: "CREATE_RECURRING",
  EDIT_RECURRING: "EDIT_RECURRING",
  RUN_RECURRING: "RUN_RECURRING",
  SET_BUDGET: "SET_BUDGET",
  DELETE_BUDGET: "DELETE_BUDGET",
  // periods
  LOCK_PERIOD: "LOCK_PERIOD",
  UNLOCK_PERIOD: "UNLOCK_PERIOD",
  // users & settings
  ADD_USER: "ADD_USER",
  EDIT_USER: "EDIT_USER",
  CHANGE_ROLE: "CHANGE_ROLE",
  DEACTIVATE_USER: "DEACTIVATE_USER",
  REACTIVATE_USER: "REACTIVATE_USER",
  RESET_PASSWORD: "RESET_PASSWORD",
  CHANGE_OWN_PASSWORD: "CHANGE_OWN_PASSWORD",
  EDIT_SETTINGS: "EDIT_SETTINGS",
  // ai
  AI_EXTRACT: "AI_EXTRACT",
} as const;

export type AuditActionName =
  (typeof AuditAction)[keyof typeof AuditAction];

type AuditInput = {
  actorId: string;
  action: AuditActionName;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
};

/**
 * Records an audit entry. Uses the given transaction client when called from
 * inside a `prisma.$transaction`, so the log commits atomically with the change.
 */
export async function recordAudit(
  input: AuditInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma;
  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      before: toJson(input.before),
      after: toJson(input.after),
    },
  });
}

/**
 * Normalises a value for Json storage: Decimals and Dates become strings so
 * the stored diff stays readable and never loses precision.
 */
export function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v === null || v === undefined) return v;
      if (typeof v === "object" && "toFixed" in v && typeof v.toFixed === "function") {
        // Prisma.Decimal
        return String(v);
      }
      if (v instanceof Date) return v.toISOString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}

/** Fields worth diffing when a transaction is edited. */
export function auditableTxnFields(txn: Record<string, unknown>) {
  const keep = [
    "type", "status", "date", "amountInr", "originalCurrency", "originalAmount",
    "fxRate", "categoryId", "vendorId", "projectId", "paymentLabel",
    "paymentMethod", "notes", "routing", "grossAmount", "grossCurrency",
    "vatAmount", "vatCurrency", "taxAmount", "receiptBlobKey", "periodLocked",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in txn) out[k] = txn[k];
  }
  return out;
}
