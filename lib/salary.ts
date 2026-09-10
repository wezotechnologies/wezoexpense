/**
 * Pro-rata salary maths (spec 5 — a rupee must never drift).
 *
 * One implementation, used by both the calculator on screen and the route that
 * records the payment, so the figure shown and the figure stored cannot
 * disagree. That rules out `lib/money.ts`, which is `server-only`: a live
 * calculator has to compute as you type, on the client.
 *
 * Doing without Decimal is safe here because money is held as **integer
 * paise** and every step is integer arithmetic — the division is done in
 * BigInt, so no intermediate is ever a float. Float would be unacceptable:
 * 33500 * 23 / 30 in binary floating point is 25683.333333333332, and rounding
 * that is a coin toss on the last paisa.
 *
 * Half-days are first-class: unpaid leave in Indian payroll is routinely half a
 * day, so days are carried internally in half-day units to keep them integral.
 *
 * No Prisma import, so this module is safe on the client.
 */

export type SalaryBasis = "calendar" | "mon-sat" | "mon-fri";

export const SALARY_BASES: {
  value: SalaryBasis;
  label: string;
  hint: string;
}[] = [
  {
    value: "calendar",
    label: "Calendar days",
    hint: "Every day of the month counts, so a full month always pays exactly the full salary.",
  },
  {
    value: "mon-sat",
    label: "Working days, Mon–Sat",
    hint: "Sundays excluded, so a day of leave costs more than on a calendar basis.",
  },
  {
    value: "mon-fri",
    label: "Working days, Mon–Fri",
    hint: "Saturdays and Sundays excluded.",
  },
];

export function isSalaryBasis(value: unknown): value is SalaryBasis {
  return value === "calendar" || value === "mon-sat" || value === "mon-fri";
}

/** ₹10 crore a month. Well beyond real use, and keeps every product exact. */
export const MAX_MONTHLY_PAISE = 10_000_000_000;

/**
 * Integer division rounded half-up, in BigInt so it is exact.
 *
 * `Math.floor(n / d)` would be wrong for the same reason floats are wrong
 * everywhere else in money: the division can land a hair below an integer and
 * floor a rupee away.
 */
function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
  if (denominator <= 0 || numerator < 0) return 0;
  // BigInt, not Number, so exactness does not rest on an argument about how
  // large the operands happen to be today. Written with the constructor rather
  // than `2n` literals because the project targets ES2017.
  const n = BigInt(Math.round(numerator));
  const d = BigInt(Math.round(denominator));
  const two = BigInt(2);
  const q = n / d;
  const r = n % d;
  return Number(r * two >= d ? q + BigInt(1) : q);
}

/** Days in a month, 1-based month key "YYYY-MM". */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseMonthKey(monthKey: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * How many days the month contains under the chosen basis.
 *
 * Computed in UTC on purpose. Which weekday a date falls on, and how many days
 * a month has, are properties of the calendar rather than of a timezone — so
 * this needs no IST offset and cannot drift with one.
 */
export function periodDaysFor(monthKey: string, basis: SalaryBasis): number {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return 0;
  const { year, month } = parsed;
  const total = daysInMonth(year, month);
  if (basis === "calendar") return total;

  let count = 0;
  for (let day = 1; day <= total; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
    const isOff = basis === "mon-sat" ? weekday === 0 : weekday === 0 || weekday === 6;
    if (!isOff) count += 1;
  }
  return count;
}

export type PayoutInput = {
  monthlyPaise: number;
  monthKey: string;
  basis: SalaryBasis;
  /** Days paid, in half-day units, so half a day stays an integer. */
  paidHalfDays: number;
};

export type Payout = {
  periodDays: number;
  paidDays: number;
  payablePaise: number;
  /** What the unpaid days cost — loss of pay. */
  lopPaise: number;
  /**
   * A day's pay, for display only. Deliberately not used to derive the total:
   * multiplying a rounded per-day figure by the days worked loses up to a
   * paisa per day, which on a 30-day month is a visibly wrong total.
   */
  perDayPaise: number;
};

export function computePayout(input: PayoutInput): Payout {
  const periodDays = periodDaysFor(input.monthKey, input.basis);
  const monthlyPaise =
    Number.isSafeInteger(input.monthlyPaise) && input.monthlyPaise >= 0
      ? Math.min(input.monthlyPaise, MAX_MONTHLY_PAISE)
      : 0;

  if (periodDays <= 0) {
    return { periodDays: 0, paidDays: 0, payablePaise: 0, lopPaise: 0, perDayPaise: 0 };
  }

  const periodHalves = periodDays * 2;
  const requested = Number.isFinite(input.paidHalfDays)
    ? Math.round(input.paidHalfDays)
    : 0;
  const paidHalves = Math.min(Math.max(requested, 0), periodHalves);

  // Full period is returned exactly, not via the division, so a complete month
  // always pays the salary to the paisa regardless of the basis chosen.
  const payablePaise =
    paidHalves === periodHalves
      ? monthlyPaise
      : divideRoundHalfUp(monthlyPaise * paidHalves, periodHalves);

  return {
    periodDays,
    paidDays: paidHalves / 2,
    payablePaise,
    lopPaise: monthlyPaise - payablePaise,
    perDayPaise: divideRoundHalfUp(monthlyPaise, periodDays),
  };
}

/**
 * Parses typed rupees into integer paise. Tolerates ₹, grouping commas and
 * whitespace; anything beyond two decimals is rounded half-up rather than
 * rejected, since a pasted figure like 33500.005 should not block the form.
 */
export function parseRupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;

  const rupees = Number(match[1]);
  if (!Number.isSafeInteger(rupees)) return null;

  const fraction = (match[2] ?? "").padEnd(3, "0");
  const paise = Number(fraction.slice(0, 2));
  const roundUp = Number(fraction[2]) >= 5 ? 1 : 0;

  const total = rupees * 100 + paise + roundUp;
  if (!Number.isSafeInteger(total) || total > MAX_MONTHLY_PAISE) return null;
  return total;
}

/** Paise as the 2dp string the API and the database expect. */
export function paiseToAmountString(paise: number): string {
  const rounded = Math.round(paise);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Rupees as a plain number, for formatInr. Display only. */
export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** "23 of 30 calendar days" — the sentence the stored note and the UI share. */
export function describeBasis(basis: SalaryBasis): string {
  return basis === "calendar" ? "calendar days" : `working days (${basis === "mon-sat" ? "Mon–Sat" : "Mon–Fri"})`;
}
