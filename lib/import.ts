import "server-only";

import { prisma } from "@/lib/prisma";
import { ApiError, type SessionUser } from "@/lib/rbac";
import { AuditAction, recordAudit } from "@/lib/audit";
import { parseCsv } from "@/lib/csv";
import { istDateToUtc, monthKeyOf } from "@/lib/dates";
import { deriveFxRate } from "@/lib/money";
import { formatZodError } from "@/lib/api";
import { importRowSchema, type ImportRow } from "@/lib/validation";
import { TxnStatus, TxnType } from "@/generated/prisma/enums";

/**
 * Bulk CSV import of historical transactions (spec 11).
 *
 * Two phases, so nothing is written on a guess:
 *   1. `previewImport` parses, maps and validates every row and reports exactly
 *      what would happen — including which categories and vendors it could not
 *      match. Nothing is written.
 *   2. `commitImport` writes only the rows that validated, in one database
 *      transaction, so a failure part-way leaves no half-imported books.
 */

/** Canonical field names, and the header spellings accepted for each. */
const HEADER_ALIASES: Record<string, string[]> = {
  type: ["type", "txn type", "transaction type", "direction", "in/out"],
  date: ["date", "txn date", "transaction date", "value date", "posted"],
  amountInr: [
    "amountinr", "amount inr", "amount (inr)", "amount", "inr", "inr amount",
    "amount in inr", "booked amount",
  ],
  category: ["category", "head", "account"],
  vendor: ["vendor", "client", "payee", "payer", "vendor/client", "counterparty"],
  paymentMethod: ["paymentmethod", "payment method", "method", "mode", "paid via"],
  paymentLabel: ["paymentlabel", "payment label", "label", "instalment", "installment"],
  notes: ["notes", "note", "description", "narration", "remarks", "particulars"],
  originalCurrency: [
    "originalcurrency", "original currency", "currency", "ccy", "foreign currency",
  ],
  originalAmount: [
    "originalamount", "original amount", "foreign amount", "amount (original)",
  ],
  routing: ["routing", "collected via", "route"],
};

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ");
}

/** Maps CSV headers onto canonical field names. */
export function inferMapping(headers: string[]): Record<number, string> {
  const mapping: Record<number, string> = {};

  headers.forEach((raw, index) => {
    const normalised = normaliseHeader(raw);
    const compact = normalised.replace(/\s+/g, "");

    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (
        aliases.includes(normalised) ||
        aliases.includes(compact) ||
        field.toLowerCase() === compact
      ) {
        // First header wins, so a duplicate column can't silently override.
        if (!Object.values(mapping).includes(field)) mapping[index] = field;
        break;
      }
    }
  });

  return mapping;
}

export type PreviewRow = {
  line: number;
  ok: boolean
  ;
  errors: string[];
  warnings: string[];
  raw: Record<string, string>;
  parsed: ImportRow | null;
  categoryId: string | null;
  vendorId: string | null;
  /** Vendor name present in the file but not yet in the directory. */
  newVendorName: string | null;
};

export type ImportPreview = {
  headers: string[];
  mapping: Record<number, string>;
  unmappedHeaders: string[];
  missingRequired: string[];
  rows: PreviewRow[];
  validCount: number;
  errorCount: number;
  newVendors: string[];
  lockedMonths: string[];
  totals: { income: string; expense: string };
};

const REQUIRED_FIELDS = ["type", "date", "amountInr"];

export async function previewImport(csvText: string): Promise<ImportPreview> {
  const table = parseCsv(csvText);
  if (table.length === 0) throw new ApiError(422, "That file appears to be empty.");

  const [headerRow, ...dataRows] = table;
  const mapping = inferMapping(headerRow);
  const mapped = new Set(Object.values(mapping));

  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapped.has(f));
  const unmappedHeaders = headerRow.filter((_, i) => !(i in mapping));

  if (dataRows.length > 2000) {
    throw new ApiError(
      422,
      `That file has ${dataRows.length} rows. Please split it into files of 2000 rows or fewer.`,
    );
  }

  // Resolve directories once rather than per row.
  const [categories, vendors, locks] = await Promise.all([
    prisma.category.findMany({ select: { id: true, name: true, type: true } }),
    prisma.vendor.findMany({ select: { id: true, name: true } }),
    prisma.periodLock.findMany({ select: { month: true } }),
  ]);

  const categoryByKey = new Map(
    categories.map((c) => [`${c.type}:${c.name.toLowerCase()}`, c.id]),
  );
  const vendorByName = new Map(vendors.map((v) => [v.name.toLowerCase(), v.id]));
  const lockedMonths = new Set(locks.map((l) => l.month));

  const rows: PreviewRow[] = [];
  const newVendors = new Set<string>();
  const touchedLockedMonths = new Set<string>();
  let income = 0;
  let expense = 0;

  dataRows.forEach((cells, index) => {
    const raw: Record<string, string> = {};
    for (const [colIndex, field] of Object.entries(mapping)) {
      raw[field] = cells[Number(colIndex)] ?? "";
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    if (missingRequired.length > 0) {
      errors.push(`Missing required column(s): ${missingRequired.join(", ")}.`);
    }

    const parsed = importRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(formatZodError(parsed.error));
    }

    let categoryId: string | null = null;
    let vendorId: string | null = null;
    let newVendorName: string | null = null;

    if (parsed.success) {
      const row = parsed.data;

      if (row.category) {
        const found = categoryByKey.get(`${row.type}:${row.category.toLowerCase()}`);
        if (found) {
          categoryId = found;
        } else {
          warnings.push(
            `No ${row.type.toLowerCase()} category called "${row.category}" — the row will be imported without a category.`,
          );
        }
      }

      if (row.vendor) {
        const found = vendorByName.get(row.vendor.toLowerCase());
        if (found) {
          vendorId = found;
        } else {
          newVendorName = row.vendor;
          newVendors.add(row.vendor);
          warnings.push(`"${row.vendor}" will be added to the directory.`);
        }
      }

      const month = monthKeyOf(istDateToUtc(row.date));
      if (lockedMonths.has(month)) {
        errors.push(`${month} is closed. Reopen it before importing into it.`);
        touchedLockedMonths.add(month);
      }

      if (errors.length === 0) {
        const amount = Number(row.amountInr);
        if (row.type === TxnType.INCOME) income += amount;
        else expense += amount;
      }
    }

    rows.push({
      line: index + 2, // +1 for the header, +1 for 1-based lines
      ok: errors.length === 0,
      errors,
      warnings,
      raw,
      parsed: parsed.success ? parsed.data : null,
      categoryId,
      vendorId,
      newVendorName,
    });
  });

  return {
    headers: headerRow,
    mapping,
    unmappedHeaders,
    missingRequired,
    rows,
    validCount: rows.filter((r) => r.ok).length,
    errorCount: rows.filter((r) => !r.ok).length,
    newVendors: [...newVendors],
    lockedMonths: [...touchedLockedMonths],
    totals: { income: income.toFixed(2), expense: expense.toFixed(2) },
  };
}

export type ImportResult = {
  created: number;
  vendorsCreated: number;
  skipped: number;
  status: TxnStatus;
};

/**
 * Writes the valid rows. Re-validates from the original CSV rather than
 * trusting a client-supplied row list, so the preview cannot be edited into
 * something that skips a period lock.
 */
export async function commitImport(
  user: SessionUser,
  csvText: string,
  options: { approve: boolean; createMissingVendors: boolean },
): Promise<ImportResult> {
  const preview = await previewImport(csvText);
  const usable = preview.rows.filter((r) => r.ok && r.parsed);

  if (usable.length === 0) {
    throw new ApiError(
      422,
      "None of the rows in that file could be imported. Check the errors shown in the preview.",
    );
  }

  const status = options.approve ? TxnStatus.APPROVED : TxnStatus.PENDING;
  let vendorsCreated = 0;

  const created = await prisma.$transaction(async (tx) => {
    // Create any missing vendors first so rows can reference them.
    const vendorIds = new Map<string, string>();
    if (options.createMissingVendors) {
      for (const name of preview.newVendors) {
        const vendor = await tx.vendor.upsert({
          where: { name },
          update: {},
          create: { name, kind: "VENDOR" },
          select: { id: true, name: true },
        });
        vendorIds.set(name.toLowerCase(), vendor.id);
        vendorsCreated++;
      }
    }

    let count = 0;
    for (const row of usable) {
      const input = row.parsed!;
      const fxRate = deriveFxRate(input.amountInr, input.originalAmount);
      const vendorId =
        row.vendorId ??
        (row.newVendorName
          ? (vendorIds.get(row.newVendorName.toLowerCase()) ?? null)
          : null);

      await tx.transaction.create({
        data: {
          type: input.type,
          status,
          date: istDateToUtc(input.date),
          amountInr: input.amountInr,
          originalCurrency: input.originalCurrency,
          originalAmount: input.originalAmount,
          fxRate: fxRate ? fxRate.toFixed(6) : null,
          categoryId: row.categoryId,
          vendorId,
          paymentLabel: input.paymentLabel,
          paymentMethod: input.paymentMethod,
          notes: input.notes,
          routing: input.routing,
          createdById: user.id,
          ...(status === TxnStatus.APPROVED
            ? { reviewedById: user.id, reviewedAt: new Date() }
            : {}),
        },
      });
      count++;
    }

    await recordAudit(
      {
        actorId: user.id,
        action: AuditAction.IMPORT_TXN,
        entity: "Transaction",
        after: {
          rowsImported: count,
          rowsSkipped: preview.errorCount,
          vendorsCreated,
          status,
          totals: preview.totals,
        },
      },
      tx,
    );

    return count;
  });

  return {
    created,
    vendorsCreated,
    skipped: preview.errorCount,
    status,
  };
}
