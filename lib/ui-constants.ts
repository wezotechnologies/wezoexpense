/**
 * Client-safe copies of the picklists used by forms.
 *
 * `lib/validation.ts` owns the authoritative lists, but it pulls in Zod; these
 * are plain arrays so a form can render options without that weight. They are
 * only suggestions — the API accepts any string for method and label, so the
 * two lists drifting cannot cause a validation failure.
 */

export const CURRENCIES_UI = [
  "INR",
  "USD",
  "AED",
  "CAD",
  "EUR",
  "GBP",
  "SGD",
] as const;

export const PAYMENT_METHODS_UI = [
  "UPI",
  "Bank transfer",
  "Card",
  "Cash",
  "PayPal",
  "Wise",
  "Cheque",
  "Other",
] as const;

export const PAYMENT_LABELS_UI = [
  "Advance",
  "1st payment",
  "2nd payment",
  "3rd payment",
  "Milestone",
  "Final",
  "Full payment",
  "Retainer",
] as const;

export const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
] as const;

export const TYPE_OPTIONS = [
  { value: "INCOME", label: "Income" },
  { value: "EXPENSE", label: "Expense" },
] as const;
