import { z } from "zod";

import { DATE_ONLY_RE, MONTH_KEY_RE } from "@/lib/dates";
import { SALARY_BASIS_VALUES } from "@/lib/salary";

/**
 * Shared Zod schemas for every API input (spec 12, 14).
 *
 * Money crosses the wire as a *string*, not a number, so a rupee value never
 * round-trips through a float. `money()` validates the text and hands back a
 * normalised decimal string for Prisma.
 *
 * No Prisma import here: these schemas are also used by client forms.
 */

/** Prisma cuid — validated by shape rather than a strict cuid matcher so the
 *  app keeps working if the id generator's format ever changes. */
export const idSchema = z
  .string()
  .min(1, { error: "Required." })
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, { error: "Invalid id." });

/**
 * Normalises a text-ish input: absent, null and whitespace-only all collapse to
 * null so an empty form control clears the field rather than storing "".
 */
function blankToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Optional field for CREATE and full-form UPDATE payloads: an absent key means
 * "no value", so it becomes null.
 *
 * Note the `.nullish()` before `.transform()`. Wrapping the *union* in an
 * undefined member instead leaves the object key required in Zod 4, which
 * silently turns every optional field into a required one.
 */
const optionalText = (max: number) =>
  z.string().nullish().transform(blankToNull).pipe(z.string().max(max).nullable());

const optionalId = z
  .string()
  .nullish()
  .transform(blankToNull)
  .pipe(idSchema.nullable());

const trimmed = (max: number) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().max(max));

/**
 * Optional field for PATCH payloads, where absent must mean "leave unchanged"
 * and an explicit null means "clear it". Keeps `undefined` distinguishable.
 */
const patchText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : blankToNull(v)))
    .pipe(z.string().max(max).nullable().optional());

const patchId = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : blankToNull(v)))
  .pipe(idSchema.nullable().optional());

/**
 * A money amount. Accepts a string or number, rejects NaN/Infinity, enforces
 * <= 2dp and the Decimal(14,2) range, and returns a canonical string.
 */
export function money(options?: { allowZero?: boolean; max?: number }) {
  const max = options?.max ?? 99_999_999_999.99; // Decimal(14,2)
  return z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const raw = typeof v === "number" ? String(v) : v.trim().replace(/[,\s₹]/g, "");
      if (raw === "") {
        ctx.addIssue({ code: "custom", message: "Enter an amount." });
        return z.NEVER;
      }
      if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid amount with at most 2 decimal places.",
        });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Enter a valid amount." });
        return z.NEVER;
      }
      if (n < 0) {
        ctx.addIssue({
          code: "custom",
          message: "Amounts cannot be negative. Use the income/expense type instead.",
        });
        return z.NEVER;
      }
      if (!options?.allowZero && n === 0) {
        ctx.addIssue({ code: "custom", message: "Amount must be more than zero." });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: "That amount is too large." });
        return z.NEVER;
      }
      return raw;
    });
}

const optionalMoney = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    return v;
  })
  .pipe(money({ allowZero: true }).nullable());

export const dateOnlySchema = z
  .string()
  .regex(DATE_ONLY_RE, { error: "Use a YYYY-MM-DD date." })
  .refine(
    (v) => {
      const [y, m, d] = v.split("-").map(Number);
      const probe = new Date(Date.UTC(y, m - 1, d));
      return (
        probe.getUTCFullYear() === y &&
        probe.getUTCMonth() === m - 1 &&
        probe.getUTCDate() === d
      );
    },
    { error: "That date doesn't exist." },
  );

export const monthKeySchema = z
  .string()
  .regex(MONTH_KEY_RE, { error: "Use a YYYY-MM month." });

export const currencySchema = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .pipe(
    z.string().regex(/^[A-Z]{3}$/, { error: "Use a 3-letter currency code." }),
  );

const optionalCurrency = z
  .string()
  .nullish()
  .transform((v) => {
    const t = blankToNull(v);
    return t === null ? null : t.toUpperCase();
  })
  .pipe(
    z
      .string()
      .regex(/^[A-Z]{3}$/, { error: "Use a 3-letter currency code." })
      .nullable(),
  );

export const txnTypeSchema = z.enum(["INCOME", "EXPENSE"]);
export const routingSchema = z.enum(["DIRECT", "VIA_DUBAI_PARTNER"]);
export const txnStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export const roleSchema = z.enum(["SUPERADMIN", "ADMIN", "EMPLOYEE"]);
export const frequencySchema = z.enum(["WEEKLY", "MONTHLY", "YEARLY"]);
export const vendorKindSchema = z.enum(["CLIENT", "VENDOR"]);

export const PAYMENT_METHODS = [
  "UPI",
  "Bank transfer",
  "Card",
  "Cash",
  "PayPal",
  "Wise",
  "Cheque",
  "Other",
] as const;

/** Suggested picklist for spec 5.3; free text is also accepted. */
export const PAYMENT_LABELS = [
  "Advance",
  "1st payment",
  "2nd payment",
  "3rd payment",
  "Milestone",
  "Final",
  "Full payment",
  "Retainer",
] as const;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const transactionBase = z.object({
  type: txnTypeSchema,
  date: dateOnlySchema,

  // INR is the source of truth (spec 5.1).
  amountInr: money(),

  // Informational original-currency pair (spec 5.2, 5.5).
  originalCurrency: optionalCurrency,
  originalAmount: optionalMoney,

  categoryId: optionalId,
  vendorId: optionalId,
  projectId: optionalId,
  paymentLabel: optionalText(80),
  paymentMethod: optionalText(40),
  notes: optionalText(2000),

  // VAT via the Dubai partner (spec 5.4) — income only.
  routing: routingSchema.default("DIRECT"),
  grossAmount: optionalMoney,
  grossCurrency: optionalCurrency,
  vatAmount: optionalMoney,
  vatCurrency: optionalCurrency,

  // Expense tax (spec 5.5).
  taxAmount: optionalMoney,

  receiptBlobKey: optionalText(300),
  receiptMime: optionalText(100),

  // AI provenance (spec 6).
  aiExtracted: z.boolean().default(false),
  aiConfidence: z.number().min(0).max(1).nullish(),
  aiRaw: z.unknown().nullish(),

  /** Admin+ may book directly as approved (spec 7.1 step 5). */
  saveAsApproved: z.boolean().default(false),
});

/** The subset of fields the cross-field rules below actually look at. */
type RefinableTransaction = {
  type: "INCOME" | "EXPENSE";
  routing: "DIRECT" | "VIA_DUBAI_PARTNER";
  originalAmount: string | null;
  originalCurrency: string | null;
  vatAmount: string | null;
  taxAmount: string | null;
};

/**
 * Cross-field rules the object shape alone can't express (spec 5.4, 5.5).
 * Shared by create and update so the two can never drift apart.
 */
function checkTransaction(v: RefinableTransaction, ctx: z.RefinementCtx): void {
  if (v.routing === "VIA_DUBAI_PARTNER" && v.type !== "INCOME") {
    ctx.addIssue({
      code: "custom",
      path: ["routing"],
      message:
        "Dubai-partner routing applies to income only — an expense cannot be routed through the partner.",
    });
  }

  if (v.originalAmount !== null && v.originalCurrency === null) {
    ctx.addIssue({
      code: "custom",
      path: ["originalCurrency"],
      message: "Choose the currency for the original amount.",
    });
  }

  if (v.vatAmount !== null && v.routing !== "VIA_DUBAI_PARTNER") {
    ctx.addIssue({
      code: "custom",
      path: ["vatAmount"],
      message:
        "VAT is only recorded when the payment was collected via the Dubai partner.",
    });
  }

  if (v.taxAmount !== null && v.type !== "EXPENSE") {
    ctx.addIssue({
      code: "custom",
      path: ["taxAmount"],
      message: "Tax amount applies to expenses. For income, record VAT instead.",
    });
  }
}

export const createTransactionSchema =
  transactionBase.superRefine(checkTransaction);
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/** Update takes the same fields; the route decides which the caller may change. */
export const updateTransactionSchema = transactionBase
  .omit({ saveAsApproved: true })
  .extend({ status: txnStatusSchema.optional() })
  .superRefine(checkTransaction);
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

export const rejectSchema = z.object({
  reason: trimmed(500).pipe(
    z.string().min(3, { error: "Give a reason so the submitter knows why." }),
  ),
});

/** Query filters for the transactions list (spec 9.4). */
export const transactionFilterSchema = z.object({
  type: txnTypeSchema.optional(),
  status: txnStatusSchema.optional(),
  categoryId: idSchema.optional(),
  vendorId: idSchema.optional(),
  projectId: idSchema.optional(),
  createdById: idSchema.optional(),
  currency: z.string().max(8).optional(),
  routing: routingSchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(["date", "amountInr", "createdAt"]).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type TransactionFilter = z.infer<typeof transactionFilterSchema>;

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

export const categoryCreateSchema = z.object({
  name: trimmed(80).pipe(z.string().min(1, { error: "Name is required." })),
  type: txnTypeSchema,
});

export const categoryUpdateSchema = z.object({
  id: idSchema,
  name: trimmed(80).pipe(z.string().min(1)).optional(),
  isActive: z.boolean().optional(),
});

export const vendorCreateSchema = z.object({
  name: trimmed(120).pipe(z.string().min(1, { error: "Name is required." })),
  kind: vendorKindSchema.default("VENDOR"),
  notes: optionalText(1000),
});

export const vendorUpdateSchema = z.object({
  id: idSchema,
  name: trimmed(120).pipe(z.string().min(1)).optional(),
  kind: vendorKindSchema.optional(),
  // patch semantics: absent leaves notes alone, explicit null clears them
  notes: patchText(1000),
  isActive: z.boolean().optional(),
});

export const projectCreateSchema = z.object({
  name: trimmed(120).pipe(z.string().min(1, { error: "Name is required." })),
  clientId: optionalId,
});

export const projectUpdateSchema = z.object({
  id: idSchema,
  name: trimmed(120).pipe(z.string().min(1)).optional(),
  clientId: patchId,
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Recurring, budgets, periods
// ---------------------------------------------------------------------------

/** The template a rule stamps out; a subset of the transaction fields. */
export const recurringTemplateSchema = z.object({
  amountInr: money(),
  /**
   * Which working week this person is paid on, for the salary calculator.
   *
   * It lives on the rule because it is a fact about the employee's contract,
   * not about one calculation — some staff are Mon–Sat and some Mon–Fri, and
   * re-picking it every month is both tedious and a chance to get it wrong.
   * Absent on rules that are not salaries, and on salaries set up before this
   * existed, which is why it is optional rather than defaulted.
   */
  salaryBasis: z.enum(SALARY_BASIS_VALUES).nullish(),
  categoryId: optionalId,
  vendorId: optionalId,
  projectId: optionalId,
  paymentMethod: optionalText(40),
  paymentLabel: optionalText(80),
  notes: optionalText(2000),
  originalCurrency: optionalCurrency,
  originalAmount: optionalMoney,
  routing: routingSchema.default("DIRECT"),
});

export const recurringCreateSchema = z.object({
  name: trimmed(120).pipe(z.string().min(1, { error: "Give the rule a name." })),
  type: txnTypeSchema,
  frequency: frequencySchema,
  nextRunDate: dateOnlySchema,
  autoApprove: z.boolean().default(false),
  isActive: z.boolean().default(true),
  template: recurringTemplateSchema,
});

/**
 * A template patch: only the keys actually sent are validated, and absent keys
 * stay `undefined` so the route can tell "not supplied" from "clear this".
 *
 * The full template schema turns an absent optional into null, which is right
 * on create — an empty form field means no vendor — but destructive on an
 * edit: a form that does not know about `salaryBasis` or `paymentLabel` would
 * erase them simply by saving an unrelated change.
 */
export const recurringTemplatePatchSchema = recurringTemplateSchema.partial();

export const recurringUpdateSchema = recurringCreateSchema
  .partial()
  .extend({ id: idSchema, template: recurringTemplatePatchSchema.optional() });

export const budgetSchema = z.object({
  categoryId: idSchema,
  month: monthKeySchema,
  amountInr: money({ allowZero: true }),
  alertPct: z.coerce.number().int().min(1).max(200).default(80),
});

export const periodSchema = z.object({ month: monthKeySchema });

// ---------------------------------------------------------------------------
// Users & settings
// ---------------------------------------------------------------------------

export const userCreateSchema = z.object({
  name: trimmed(120).pipe(z.string().min(1, { error: "Name is required." })),
  email: z.email({ error: "Enter a valid email address." }).transform((v) => v.toLowerCase().trim()),
  role: roleSchema,
  password: z
    .string()
    .min(10, { error: "Use at least 10 characters." })
    .regex(/[a-zA-Z]/, { error: "Include at least one letter." })
    .regex(/[0-9]/, { error: "Include at least one number." }),
});

export const userUpdateSchema = z.object({
  id: idSchema,
  name: trimmed(120).pipe(z.string().min(1)).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  newPassword: z
    .string()
    .min(10, { error: "Use at least 10 characters." })
    .regex(/[a-zA-Z]/, { error: "Include at least one letter." })
    .regex(/[0-9]/, { error: "Include at least one number." })
    .optional(),
});

export const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1, { error: "Enter your current password." }),
  newPassword: z
    .string()
    .min(10, { error: "Use at least 10 characters." })
    .regex(/[a-zA-Z]/, { error: "Include at least one letter." })
    .regex(/[0-9]/, { error: "Include at least one number." }),
});

export const settingsSchema = z.object({
  baseCurrency: currencySchema.optional(),
  aiModel: trimmed(60).pipe(z.string().min(1)).optional(),
  aiMonthlySpendCapUsd: z.coerce.number().min(0).max(10_000).optional(),
  approvalRequired: z.boolean().optional(),
  vatEnabled: z.boolean().optional(),
});

export const themeSchema = z.object({ theme: z.enum(["dark", "light"]) });

// ---------------------------------------------------------------------------
// AI & uploads
// ---------------------------------------------------------------------------

export const aiExtractSchema = z.object({
  blobKey: trimmed(300).pipe(z.string().min(1, { error: "Upload a file first." })),
  mime: trimmed(100).pipe(z.string().min(1)),
});

// ---------------------------------------------------------------------------
// Reports & import
// ---------------------------------------------------------------------------

export const REPORT_TYPES = [
  "pnl",
  "expenses-by-category",
  "expenses-by-vendor",
  "income-summary",
  "cash-flow",
  "budget-vs-actual",
  "user-submissions",
] as const;

export const reportTypeSchema = z.enum(REPORT_TYPES);

export const reportQuerySchema = z.object({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  month: monthKeySchema.optional(),
  status: txnStatusSchema.optional(),
  categoryId: idSchema.optional(),
  vendorId: idSchema.optional(),
  projectId: idSchema.optional(),
  createdById: idSchema.optional(),
  fmt: z.enum(["pdf", "csv"]).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** One row of a bulk CSV import, after column mapping (spec 11). */
export const importRowSchema = z.object({
  type: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .pipe(txnTypeSchema),
  date: dateOnlySchema,
  amountInr: money(),
  category: optionalText(80),
  vendor: optionalText(120),
  paymentMethod: optionalText(40),
  paymentLabel: optionalText(80),
  notes: optionalText(2000),
  originalCurrency: optionalCurrency,
  originalAmount: optionalMoney,
  routing: z
    .string()
    .nullish()
    .transform((v) => {
      const t = (v ?? "DIRECT").trim().toUpperCase().replace(/[\s-]+/g, "_");
      return t === "" ? "DIRECT" : t;
    })
    .pipe(routingSchema),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importCommitSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(2000),
  approve: z.boolean().default(false),
});

/**
 * Recording a pro-rata salary payment (POST /api/salary).
 *
 * The amount is deliberately absent. The server recomputes it from these
 * inputs with lib/salary.ts, so the stored figure is derived from the same
 * arithmetic the calculator showed rather than trusted from the request — and
 * the inputs land in the transaction's notes, which makes the number
 * reproducible months later when someone asks how it was arrived at.
 */
export const recordSalarySchema = z.object({
  monthlyInr: money(),
  month: monthKeySchema,
  basis: z.enum(SALARY_BASIS_VALUES),
  /** Half-day units, so 23.5 days is exact rather than a float. */
  paidHalfDays: z.coerce.number().int().min(0).max(124),
  employeeName: trimmed(120).pipe(
    z.string().min(1, { error: "Say who this payment is for." }),
  ),
  date: dateOnlySchema,
  categoryId: optionalId,
  vendorId: optionalId,
  notes: optionalText(2000),
  saveAsApproved: z.boolean().default(false),
});
export type RecordSalaryInput = z.infer<typeof recordSalarySchema>;

/** Remembering a person's working week against their recurring rule. */
export const setSalaryBasisSchema = z.object({
  ruleId: idSchema,
  basis: z.enum(SALARY_BASIS_VALUES),
});
export type SetSalaryBasisInput = z.infer<typeof setSalaryBasisSchema>;
