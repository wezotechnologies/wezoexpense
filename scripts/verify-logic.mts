/**
 * Pure-logic verification — no server, no database.
 *
 *   npx tsx scripts/verify-logic.mts
 *
 * Covers the three areas where a quiet mistake would corrupt the books:
 * IST/UTC date boundaries, money and cross-field validation, and the defensive
 * parsing of AI output.
 */

import {
  addMonths,
  advanceByFrequency,
  dateKeyOf,
  dayRangeUtc,
  istDateToUtc,
  monthEndDateKey,
  monthKeyOf,
  monthKeysBetween,
  monthRangeUtc,
} from "../lib/dates";
import {
  createTransactionSchema,
  importRowSchema,
  money,
  vendorUpdateSchema,
} from "../lib/validation";
import { bandFor, normaliseDraft } from "../lib/ai-parse";

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, got?: unknown): void {
  if (condition) {
    passed++;
    console.log("  ok  ", label, got !== undefined ? `-> ${JSON.stringify(got)}` : "");
  } else {
    failed++;
    console.log("  FAIL", label, got !== undefined ? `-> ${JSON.stringify(got)}` : "");
  }
}

function section(title: string): void {
  console.log(`\n=============== ${title} ===============`);
}

// ---------------------------------------------------------------------------
section("Dates: IST is the calendar, UTC is the storage");
// ---------------------------------------------------------------------------

ok("3 Sep IST is stored as 2 Sep 18:30 UTC",
  istDateToUtc("2026-09-03").toISOString() === "2026-09-02T18:30:00.000Z");
ok("and reads back as the same Indian day",
  dateKeyOf(istDateToUtc("2026-09-03")) === "2026-09-03");

const sept = monthRangeUtc("2026-09");
ok("1 Sep falls inside September",
  istDateToUtc("2026-09-01") >= sept.gte && istDateToUtc("2026-09-01") < sept.lt);
ok("30 Sep falls inside September",
  istDateToUtc("2026-09-30") >= sept.gte && istDateToUtc("2026-09-30") < sept.lt);
ok("31 Aug does not", !(istDateToUtc("2026-08-31") >= sept.gte));
ok("1 Oct does not", !(istDateToUtc("2026-10-01") < sept.lt));

// 2026-09-30T20:30Z is 1 Oct 02:00 IST — the case a naive UTC bucket gets wrong.
ok("an instant that is 1 Oct in India buckets to October, not September",
  monthKeyOf(new Date("2026-09-30T20:30:00Z")) === "2026-10");
ok("23:00 IST stays on the same Indian day",
  dateKeyOf(new Date("2026-09-03T17:30:00Z")) === "2026-09-03");

ok("monthly recurrence clamps 31 Jan to end of Feb",
  dateKeyOf(advanceByFrequency(istDateToUtc("2026-01-31"), "MONTHLY")) === "2026-02-28");
ok("and to 29 Feb in a leap year",
  dateKeyOf(advanceByFrequency(istDateToUtc("2028-01-31"), "MONTHLY")) === "2028-02-29");
ok("weekly advances 7 days",
  dateKeyOf(advanceByFrequency(istDateToUtc("2026-09-01"), "WEEKLY")) === "2026-09-08");
ok("addMonths crosses a year boundary", addMonths("2026-01", -1) === "2025-12");
ok("monthKeysBetween is inclusive",
  monthKeysBetween("2026-07", "2026-10").join(",") === "2026-07,2026-08,2026-09,2026-10");
ok("Feb 2026 ends on the 28th", monthEndDateKey("2026-02") === "2026-02-28");
ok("Feb 2028 ends on the 29th", monthEndDateKey("2028-02") === "2028-02-29");

const range = dayRangeUtc("2026-09-01", "2026-09-30");
ok("an inclusive range includes its last day",
  istDateToUtc("2026-09-30") < range.lt);

// ---------------------------------------------------------------------------
section("Money: exact, and never negative by accident");
// ---------------------------------------------------------------------------

ok("2dp accepted", money().safeParse("1500.50").success);
ok("Indian grouping and ₹ tolerated", money().safeParse("₹1,20,000.00").success);
ok("3dp rejected", !money().safeParse("10.005").success);
ok("negative rejected", !money().safeParse("-5").success);
ok("zero rejected by default", !money().safeParse("0").success);
ok("zero allowed when opted in", money({ allowZero: true }).safeParse("0").success);
ok("text rejected", !money().safeParse("abc").success);
ok("precision preserved as a string",
  money().safeParse("0.10").data === "0.10", money().safeParse("0.10").data);

// ---------------------------------------------------------------------------
section("Transaction rules (spec 5.2, 5.4, 5.5)");
// ---------------------------------------------------------------------------

const base = { type: "EXPENSE", date: "2026-09-03", amountInr: "1500.50" } as const;
const why = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  r.success ? "" : `${String(r.error!.issues[0].path[0])}: ${r.error!.issues[0].message}`;

const viaPartner = createTransactionSchema.safeParse({
  ...base, type: "INCOME", amountInr: "47500.00", routing: "VIA_DUBAI_PARTNER",
  grossAmount: "2100.00", grossCurrency: "AED", vatAmount: "100.00", vatCurrency: "AED",
});
ok("income via the Dubai partner with VAT is accepted", viaPartner.success, why(viaPartner));

const expenseViaPartner = createTransactionSchema.safeParse({
  ...base, routing: "VIA_DUBAI_PARTNER",
});
ok("an EXPENSE cannot be routed via the partner",
  !expenseViaPartner.success && why(expenseViaPartner).startsWith("routing"),
  why(expenseViaPartner));

const vatDirect = createTransactionSchema.safeParse({
  ...base, type: "INCOME", routing: "DIRECT", vatAmount: "50",
});
ok("VAT without partner routing is rejected",
  !vatDirect.success && why(vatDirect).startsWith("vatAmount"), why(vatDirect));

const taxOnIncome = createTransactionSchema.safeParse({ ...base, type: "INCOME", taxAmount: "10" });
ok("tax on income is rejected (VAT is the income concept)",
  !taxOnIncome.success && why(taxOnIncome).startsWith("taxAmount"), why(taxOnIncome));
ok("tax on an expense is fine",
  createTransactionSchema.safeParse({ ...base, taxAmount: "10" }).success);

const amountNoCurrency = createTransactionSchema.safeParse({ ...base, originalAmount: "200" });
ok("an original amount needs its currency",
  !amountNoCurrency.success && why(amountNoCurrency).startsWith("originalCurrency"),
  why(amountNoCurrency));

const pair = createTransactionSchema.safeParse({
  ...base, originalAmount: "200", originalCurrency: "usd",
});
ok("currency codes are upper-cased",
  pair.success && pair.data.originalCurrency === "USD");

ok("31 February is rejected",
  !createTransactionSchema.safeParse({ ...base, date: "2026-02-31" }).success);
ok("29 Feb 2026 is rejected (not a leap year)",
  !createTransactionSchema.safeParse({ ...base, date: "2026-02-29" }).success);
ok("29 Feb 2028 is accepted",
  createTransactionSchema.safeParse({ ...base, date: "2028-02-29" }).success);
ok("DD/MM/YYYY is rejected",
  !createTransactionSchema.safeParse({ ...base, date: "03/09/2026" }).success);

const minimal = createTransactionSchema.safeParse(base);
ok("a bare payload is accepted", minimal.success, why(minimal));
ok("absent optionals become null, not undefined",
  minimal.success && minimal.data.categoryId === null && minimal.data.notes === null);
ok("routing defaults to DIRECT", minimal.success && minimal.data.routing === "DIRECT");

const blanks = createTransactionSchema.safeParse({ ...base, categoryId: "", notes: "  " });
ok("blank form fields collapse to null",
  blanks.success && blanks.data.categoryId === null && blanks.data.notes === null);

const patchAbsent = vendorUpdateSchema.safeParse({ id: "abc123", isActive: false });
ok("PATCH: an absent field means 'leave alone'",
  patchAbsent.success && patchAbsent.data.notes === undefined);
const patchNull = vendorUpdateSchema.safeParse({ id: "abc123", notes: null });
ok("PATCH: an explicit null means 'clear it'",
  patchNull.success && patchNull.data.notes === null);

const row = importRowSchema.safeParse({
  type: "income", date: "2026-09-03", amountInr: "20000", routing: "via dubai partner",
});
ok("CSV import normalises loose type and routing spellings",
  row.success && row.data.type === "INCOME" && row.data.routing === "VIA_DUBAI_PARTNER");

// ---------------------------------------------------------------------------
section("AI output parsing (spec 8.2, 8.3)");
// ---------------------------------------------------------------------------

ok("0.92 pre-fills normally", bandFor(0.92) === "high");
ok("0.75 is the high threshold", bandFor(0.75) === "high");
ok("0.60 asks the user to verify", bandFor(0.6) === "verify");
ok("0.50 is the verify threshold", bandFor(0.5) === "verify");
ok("0.31 routes to the manual form", bandFor(0.31) === "low");

ok("a non-object reply yields no draft", normaliseDraft("not json") === null);
ok("null yields no draft", normaliseDraft(null) === null);
ok("an empty object still opens the form", normaliseDraft({}) !== null);

const messy = normaliseDraft({
  type: "INCOME",
  date: "03/09/2026",
  vendor: "  Acme Ltd  ",
  originalCurrency: "usd",
  originalAmount: "1,250.75",
  taxOrVatAmount: "",
  paymentMethod: "null",
  confidence: 5,
  fieldConfidence: { amount: "0.8", date: -3, vendor: null, category: 99 },
  reasoning: 12345,
});
ok("case-insensitive type", messy?.type === "income");
ok("a wrongly formatted date is dropped rather than shown", messy?.date === null);
ok("whitespace is trimmed", messy?.vendor === "Acme Ltd");
ok("grouped numerals parse", messy?.originalAmount === 1250.75);
ok("empty strings become null", messy?.taxOrVatAmount === null);
ok('the literal string "null" becomes null', messy?.paymentMethod === null);
ok("out-of-range confidence is clamped", messy?.confidence === 1);
ok("per-field confidence is coerced and clamped",
  messy?.fieldConfidence.amount === 0.8 &&
  messy?.fieldConfidence.date === 0 &&
  messy?.fieldConfidence.vendor === 0 &&
  messy?.fieldConfidence.category === 1);
ok("a non-string reasoning becomes empty", messy?.reasoning === "");
ok("an unrecognised type becomes 'unknown'",
  normaliseDraft({ type: "banana" })?.type === "unknown");
ok("a missing confidence defaults low enough to prompt review",
  normaliseDraft({})?.confidence === 0.4);
ok("a ₹-prefixed amount parses",
  normaliseDraft({ amountInr: "₹ 20,000.00" })?.amountInr === 20000);

// ---------------------------------------------------------------------------
console.log("\n==================================================");
console.log(`  PASSED: ${passed}    FAILED: ${failed}`);
console.log("==================================================");
process.exit(failed === 0 ? 0 : 1);
