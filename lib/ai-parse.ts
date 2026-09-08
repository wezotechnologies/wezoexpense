/**
 * Pure parsing for AI extraction output (spec 8.2, 8.3).
 *
 * Deliberately separate from `lib/ai.ts`: that module is `server-only` because
 * it holds the OpenAI key and touches storage, while everything here is a pure
 * function of the model's reply. Keeping them apart means the normalisation
 * rules — the part that has to survive a model returning something odd — can be
 * exercised on their own.
 */

export type FieldConfidence = {
  amount: number;
  date: number;
  vendor: number;
  category: number;
};

export type ExtractionDraft = {
  type: "income" | "expense" | "unknown";
  date: string | null;
  vendor: string | null;
  originalCurrency: string | null;
  originalAmount: number | null;
  amountInr: number | null;
  taxOrVatAmount: number | null;
  paymentMethod: string | null;
  suggestedCategory: string | null;
  confidence: number;
  fieldConfidence: FieldConfidence;
  reasoning: string;
};

/** How the Add screen should behave (spec 8.3). */
export type ConfidenceBand = "high" | "verify" | "low";

export function bandFor(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "verify";
  return "low";
}

function clamp01(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "null" ? null : trimmed;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[,\s₹$]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalises whatever the model returned into an ExtractionDraft.
 * Never throws — an unusable payload becomes null, and a partially usable one
 * becomes a draft with the bad fields dropped, so the form can still open.
 */
export function normaliseDraft(raw: unknown): ExtractionDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const rawType = nullableString(r.type)?.toLowerCase();
  const type: ExtractionDraft["type"] =
    rawType === "income" || rawType === "expense" ? rawType : "unknown";

  const fc = (r.fieldConfidence ?? {}) as Record<string, unknown>;
  const date = nullableString(r.date);

  return {
    type,
    // Keep only a well-formed calendar date; anything else is dropped so the
    // form falls back to today rather than showing a nonsense value.
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    vendor: nullableString(r.vendor),
    originalCurrency: nullableString(r.originalCurrency)?.toUpperCase() ?? null,
    originalAmount: nullableNumber(r.originalAmount),
    amountInr: nullableNumber(r.amountInr),
    taxOrVatAmount: nullableNumber(r.taxOrVatAmount),
    paymentMethod: nullableString(r.paymentMethod),
    suggestedCategory: nullableString(r.suggestedCategory),
    confidence: clamp01(r.confidence, 0.4),
    fieldConfidence: {
      amount: clamp01(fc.amount),
      date: clamp01(fc.date),
      vendor: clamp01(fc.vendor),
      category: clamp01(fc.category),
    },
    reasoning: nullableString(r.reasoning) ?? "",
  };
}
