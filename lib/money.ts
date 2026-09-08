import "server-only";

import { Prisma } from "@/generated/prisma/client";

/**
 * Server-side money maths (spec 5, 17).
 *
 * Two hard rules:
 *  1. All arithmetic goes through Prisma.Decimal — never float. A rupee must
 *     never drift.
 *  2. `amountInr` is the source of truth. Original currency/amount are
 *     informational; `fxRate` is *derived* from the two, never typed in.
 *
 * Decimal instances are class objects and don't survive the Server -> Client
 * boundary, so values are stringified with `toMoneyString` before being handed
 * to a Client Component, which formats them via lib/format.ts.
 */

export type DecimalLike = Prisma.Decimal | string | number;

export const ZERO = new Prisma.Decimal(0);

export function dec(value: DecimalLike): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value ?? 0);
}

/** Rounds to 2dp — the stored and displayed precision for INR. */
export function toInr(value: DecimalLike): Prisma.Decimal {
  return dec(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function sum(values: DecimalLike[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), new Prisma.Decimal(0));
}

/** Serialises a Decimal for transport to the client. */
export function toMoneyString(
  value: DecimalLike | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return toInr(value).toFixed(2);
}

/** Same, but never null — for totals that should read as zero. */
export function toMoneyStringOrZero(value: DecimalLike | null | undefined): string {
  return toMoneyString(value ?? 0) ?? "0.00";
}

/**
 * Derives the effective FX rate for a foreign-currency transaction.
 * Spec 5.2: client pays USD 200, bank credits INR 20,000 -> rate 100.0.
 * Returns null when it cannot be computed (missing or non-positive original).
 */
export function deriveFxRate(
  amountInr: DecimalLike,
  originalAmount: DecimalLike | null | undefined,
): Prisma.Decimal | null {
  if (originalAmount === null || originalAmount === undefined) return null;
  const original = dec(originalAmount);
  if (original.isZero() || original.isNegative()) return null;
  return dec(amountInr)
    .div(original)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Parses user-typed money. Tolerates grouping separators, currency symbols and
 * stray whitespace; rejects anything that isn't a plain number.
 */
export function parseMoney(
  input: string | number | null | undefined,
): Prisma.Decimal | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? dec(input) : null;
  }
  const cleaned = input.replace(/[₹$€£,\s]/g, "").replace(/^\+/, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  try {
    return new Prisma.Decimal(cleaned);
  } catch {
    return null;
  }
}

/** Percentage of a total, guarding divide-by-zero. Returns 0..100. */
export function percentOf(part: DecimalLike, total: DecimalLike): number {
  const t = dec(total);
  if (t.isZero()) return 0;
  return Number(dec(part).div(t).times(100).toDecimalPlaces(1));
}

/** Currencies offered in the UI. INR is the reporting currency (spec 5.1). */
export const CURRENCIES = [
  "INR",
  "USD",
  "AED",
  "CAD",
  "EUR",
  "GBP",
  "SGD",
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];

export function isKnownCurrency(code: string): boolean {
  return (CURRENCIES as readonly string[]).includes(code);
}
