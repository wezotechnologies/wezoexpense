/**
 * Date handling (spec 17): store UTC, reason and display in Asia/Kolkata.
 *
 * India has been UTC+05:30 year-round with no DST since 1945, so a fixed
 * offset is exact here and lets month bucketing stay pure arithmetic instead of
 * pulling in a timezone database.
 *
 * The convention: a transaction "dated 3 Sep 2026" is stored as IST midnight of
 * that day expressed in UTC (2026-09-02T18:30:00Z). Formatting that instant in
 * Asia/Kolkata reads back as 03 Sep 2026, and month buckets line up with the
 * Indian calendar month rather than the UTC one.
 *
 * No Prisma import here, so this module is safe on the client too.
 */

export const IST_OFFSET_MINUTES = 330; // +05:30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

/** Month key format used by Budget and PeriodLock: "2026-09". */
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Date-only input format: "2026-09-03". */
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Wall-clock civil fields of an instant, as seen in IST. */
function istParts(instant: Date): {
  year: number;
  month: number;
  day: number;
} {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** "2026-09" for the IST calendar month an instant falls in. */
export function monthKeyOf(instant: Date): string {
  const { year, month } = istParts(instant);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The current IST month key. */
export function currentMonthKey(now: Date = new Date()): string {
  return monthKeyOf(now);
}

/** "2026-09-03" for the IST calendar day an instant falls in. */
export function dateKeyOf(instant: Date): string {
  const { year, month, day } = istParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Converts a date-only string typed by a user (interpreted as an IST calendar
 * day) into the UTC instant we store. Throws on malformed input.
 */
export function istDateToUtc(dateOnly: string): Date {
  if (!DATE_ONLY_RE.test(dateOnly)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${dateOnly}"`);
  }
  const [y, m, d] = dateOnly.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const instant = new Date(utcMidnight - IST_OFFSET_MS);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Invalid date "${dateOnly}"`);
  }
  return instant;
}

/** Accepts a date-only string or a full ISO instant and normalises to UTC. */
export function parseDateInput(value: string): Date {
  if (DATE_ONLY_RE.test(value)) return istDateToUtc(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${value}"`);
  return d;
}

/**
 * Half-open UTC range `[gte, lt)` covering an IST calendar month.
 * Use for every month-scoped query so boundaries can't double-count.
 */
export function monthRangeUtc(monthKey: string): { gte: Date; lt: Date } {
  if (!MONTH_KEY_RE.test(monthKey)) {
    throw new Error(`Expected a YYYY-MM month, got "${monthKey}"`);
  }
  const [y, m] = monthKey.split("-").map(Number);
  return {
    gte: new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS),
    lt: new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS),
  };
}

/**
 * Half-open UTC range covering the IST days `from`..`to` inclusive.
 * `to` is pushed to the start of the following IST day.
 */
export function dayRangeUtc(from: string, to: string): { gte: Date; lt: Date } {
  const gte = istDateToUtc(from);
  const toStart = istDateToUtc(to);
  return { gte, lt: new Date(toStart.getTime() + 24 * 60 * 60 * 1000) };
}

/** Shifts a month key by n months: ("2026-09", -1) -> "2026-08". */
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const zero = y * 12 + (m - 1) + n;
  const year = Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Inclusive list of month keys from `start` to `end`. */
export function monthKeysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cursor = start;
  // Guard against a reversed range or a pathological span.
  for (let i = 0; i < 600; i++) {
    out.push(cursor);
    if (cursor === end || cursor > end) break;
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/** Month keys covering the IST months touched by a UTC instant range. */
export function monthKeysCovering(from: Date, to: Date): string[] {
  return monthKeysBetween(monthKeyOf(from), monthKeyOf(to));
}

/** First IST day of a month, as a date-only string. */
export function monthStartDateKey(monthKey: string): string {
  return `${monthKey}-01`;
}

/** Last IST day of a month, as a date-only string. */
export function monthEndDateKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

/** Advances a recurring rule's next run date (spec 7.4). */
export function advanceByFrequency(
  from: Date,
  frequency: "WEEKLY" | "MONTHLY" | "YEARLY",
): Date {
  // Work in IST civil time so "the 1st of the month" stays the 1st in India.
  const shifted = new Date(from.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const hh = shifted.getUTCHours();
  const mm = shifted.getUTCMinutes();

  let next: number;
  if (frequency === "WEEKLY") {
    next = Date.UTC(y, m, d + 7, hh, mm);
  } else if (frequency === "YEARLY") {
    next = Date.UTC(y + 1, m, d, hh, mm);
  } else {
    // Monthly: clamp to the last day of the target month so 31 Jan -> 28 Feb
    // instead of silently rolling into March.
    const targetLast = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
    next = Date.UTC(y, m + 1, Math.min(d, targetLast), hh, mm);
  }
  return new Date(next - IST_OFFSET_MS);
}

/** Today as an IST date-only string — the default for new transactions. */
export function todayDateKey(now: Date = new Date()): string {
  return dateKeyOf(now);
}
