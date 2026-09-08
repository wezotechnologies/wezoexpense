/**
 * Client-safe formatting. Deliberately free of any Prisma import so Client
 * Components can use it without dragging the database client into the PWA
 * bundle. Money arrives from the server as a 2dp string (see lib/money.ts).
 */

export type MoneyInput = string | number | null | undefined;

function toNumber(value: MoneyInput): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrWhole = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** "₹20,000.00" — Indian digit grouping (lakh/crore). */
export function formatInr(value: MoneyInput): string {
  const n = toNumber(value);
  return n === null ? "—" : inr.format(n);
}

/** "₹20,000" — KPI tiles and chart axes, where paise are noise. */
export function formatInrCompact(value: MoneyInput): string {
  const n = toNumber(value);
  return n === null ? "—" : inrWhole.format(n);
}

/** Abbreviated Indian scale for tight chart axes: ₹1.2L, ₹3.4Cr. */
export function formatInrShort(value: MoneyInput): string {
  const n = toNumber(value);
  if (n === null) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2).replace(/\.00$/, "")}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2).replace(/\.00$/, "")}L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Original-currency reference amount, e.g. "US$200.00". */
export function formatForeign(
  value: MoneyInput,
  currency: string | null | undefined,
): string | null {
  const n = toNumber(value);
  if (n === null || !currency) return null;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function formatSignedInr(value: MoneyInput): string {
  const n = toNumber(value);
  if (n === null) return "—";
  if (n === 0) return formatInr(0);
  return (n < 0 ? "−" : "+") + formatInr(Math.abs(n));
}

/** "100.00" style FX rate display. */
export function formatFxRate(value: MoneyInput): string | null {
  const n = toNumber(value);
  if (n === null) return null;
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// Dates — always displayed in Asia/Kolkata (spec 17)
// ---------------------------------------------------------------------------

export const APP_TIME_ZONE = "Asia/Kolkata";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const monthFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIME_ZONE,
  month: "long",
  year: "numeric",
});

function asDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "03 Sep 2026" in IST. */
export function formatDate(value: string | number | Date | null | undefined): string {
  const d = asDate(value);
  return d ? dateFmt.format(d) : "—";
}

/** "03 Sep 2026, 04:12 pm" in IST. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = asDate(value);
  return d ? dateTimeFmt.format(d) : "—";
}

/** "September 2026" from a "2026-09" month key. */
export function formatMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return monthFmt.format(new Date(Date.UTC(y, m - 1, 1)));
}

/** "Sep 26" — short label for chart buckets. */
export function formatMonthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    month: "short",
    year: "2-digit",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Value for an <input type="date"> from a stored UTC instant, in IST. */
export function toDateInputValue(
  value: string | number | Date | null | undefined,
): string {
  const d = asDate(value);
  if (!d) return "";
  // en-CA gives ISO-ish yyyy-mm-dd, which is what date inputs expect.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Relative "2 hours ago" for the notification feed and audit log. */
export function formatRelative(
  value: string | number | Date | null | undefined,
): string {
  const d = asDate(value);
  if (!d) return "—";
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
  ];
  let delta = seconds;
  for (const [unit, span] of table) {
    if (Math.abs(delta) < span) return rtf.format(-Math.round(delta), unit);
    delta /= span;
  }
  return rtf.format(-Math.round(delta), "year");
}

// ---------------------------------------------------------------------------
// Misc display helpers
// ---------------------------------------------------------------------------

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
