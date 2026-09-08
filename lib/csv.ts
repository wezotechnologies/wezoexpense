import "server-only";

import type { Report, ReportColumn, ReportRow, ReportTable } from "@/lib/reports";
import { formatDate } from "@/lib/format";
import type { TransactionDTO } from "@/lib/transactions";

/**
 * CSV export (spec 10). RFC 4180 quoting, written by hand rather than pulled in
 * as a dependency so the escaping rules are visible and testable.
 *
 * Security note: a cell beginning with = + - @ or a control character is
 * treated as a formula by Excel, Sheets and LibreOffice. Vendor names and notes
 * are user-supplied and end up in exported books, so such cells are prefixed
 * with an apostrophe to neutralise them. Without this, "=1+1" in a note would
 * evaluate — and worse payloads can exfiltrate data via HYPERLINK().
 */

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text = String(value);

  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }

  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(escapeCsvCell).join(",");
}

/** Joins lines with CRLF, which is what RFC 4180 specifies. */
function joinLines(lines: string[]): string {
  return lines.join("\r\n") + "\r\n";
}

/** Renders one cell for CSV: dates become readable, money stays raw. */
function cellFor(row: ReportRow, column: ReportColumn): unknown {
  const raw = row[column.key];
  if (raw === null || raw === undefined) return "";
  if (column.kind === "date") return formatDate(String(raw));
  if (column.kind === "percent") return raw === "" ? "" : `${raw}%`;
  // Money is emitted as a bare 2dp number so spreadsheets can sum it.
  return raw;
}

export function tableToCsvLines(table: ReportTable): string[] {
  const lines: string[] = [];
  if (table.title) lines.push(csvRow([table.title]));
  lines.push(csvRow(table.columns.map((c) => c.label)));

  if (table.rows.length === 0) {
    lines.push(csvRow([table.emptyMessage ?? "No data"]));
  } else {
    for (const row of table.rows) {
      lines.push(csvRow(table.columns.map((c) => cellFor(row, c))));
    }
  }

  if (table.total) {
    lines.push(csvRow(table.columns.map((c) => cellFor(table.total!, c))));
  }
  return lines;
}

/** Full report as CSV, including the header block and memo lines. */
export function reportToCsv(report: Report): string {
  const lines: string[] = [];

  lines.push(csvRow(["Wezo Technologies"]));
  lines.push(csvRow([report.title]));
  lines.push(csvRow(["Period", report.periodLabel]));
  lines.push(csvRow(["Basis", report.basisNote]));
  lines.push(
    csvRow(["Generated", `${formatDate(report.generatedAt)} by ${report.generatedByName}`]),
  );
  for (const note of report.filterNotes) {
    lines.push(csvRow(["Filter", note]));
  }
  lines.push("");

  for (const tile of report.summary) {
    lines.push(csvRow([tile.label, tile.value]));
  }

  for (const table of report.tables) {
    lines.push("");
    lines.push(...tableToCsvLines(table));
  }

  if (report.memos.length > 0) {
    lines.push("");
    lines.push(csvRow(["Notes"]));
    for (const memo of report.memos) lines.push(csvRow([memo]));
  }

  return joinLines(lines);
}

/**
 * Raw transaction rows for the Transactions screen's "export current filter"
 * (spec 9.4). One row per transaction, every field a bookkeeper would want.
 */
export function transactionsToCsv(rows: TransactionDTO[]): string {
  const header = [
    "Date",
    "Type",
    "Status",
    "Amount INR",
    "Category",
    "Vendor/Client",
    "Project",
    "Payment label",
    "Payment method",
    "Routing",
    "Original currency",
    "Original amount",
    "FX rate",
    "Gross amount",
    "Gross currency",
    "VAT amount",
    "VAT currency",
    "Tax amount",
    "Notes",
    "Submitted by",
    "Reviewed by",
    "Reviewed at",
    "Rejection reason",
    "AI extracted",
    "AI confidence",
    "Has receipt",
    "Period locked",
    "Transaction ID",
  ];

  const lines = [csvRow(header)];

  for (const r of rows) {
    lines.push(
      csvRow([
        formatDate(r.date),
        r.type,
        r.status,
        r.amountInr,
        r.categoryName ?? "",
        r.vendorName ?? "",
        r.projectName ?? "",
        r.paymentLabel ?? "",
        r.paymentMethod ?? "",
        r.routing === "VIA_DUBAI_PARTNER" ? "Via Dubai partner" : "Direct",
        r.originalCurrency ?? "",
        r.originalAmount ?? "",
        r.fxRate ?? "",
        r.grossAmount ?? "",
        r.grossCurrency ?? "",
        r.vatAmount ?? "",
        r.vatCurrency ?? "",
        r.taxAmount ?? "",
        r.notes ?? "",
        r.createdByName,
        r.reviewedByName ?? "",
        r.reviewedAt ? formatDate(r.reviewedAt) : "",
        r.rejectionReason ?? "",
        r.aiExtracted ? "yes" : "no",
        r.aiConfidence === null ? "" : r.aiConfidence.toFixed(2),
        r.hasReceipt ? "yes" : "no",
        r.periodLocked ? "yes" : "no",
        r.id,
      ]),
    );
  }

  return joinLines(lines);
}

/** Builds the download response for a CSV payload. */
export function csvResponse(csv: string, filename: string): Response {
  // A BOM makes Excel open UTF-8 correctly, which matters for the ₹ sign.
  const body = "﻿" + csv;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// Parsing (for bulk import — spec 11)
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV parser. Handles quoted fields, escaped quotes (""), embedded
 * commas and newlines, and both CRLF and LF line endings. Also strips a UTF-8
 * BOM, which Excel writes and which would otherwise corrupt the first header.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Ignore blank trailing lines rather than emitting empty rows.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      endField();
      i++;
      continue;
    }
    if (char === "\r") {
      if (input[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (char === "\n") {
      endRow();
      i++;
      continue;
    }

    field += char;
    i++;
  }

  // Flush whatever the last line left behind.
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

/** Safe, dated filename stem for an export. */
export function exportFilename(
  stem: string,
  extension: "csv" | "pdf",
  periodLabel?: string,
): string {
  const slug = [stem, periodLabel]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `wezo-${slug || "export"}.${extension}`;
}
