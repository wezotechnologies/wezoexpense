import "server-only";

import PDFDocument from "pdfkit";

import { formatDate, formatDateTime } from "@/lib/format";
import type {
  Report,
  ReportColumn,
  ReportRow,
  ReportTable,
  SummaryTile,
} from "@/lib/reports";

/**
 * PDF export (spec 10): a clean, branded, dark-on-white document carrying the
 * Wezo mark, the period, who generated it, and the totals.
 *
 * Font note: the PDF standard fonts use WinAnsi encoding, which has no rupee
 * glyph (U+20B9) — printing "₹" would emit a broken character. Money is
 * therefore rendered with Indian digit grouping and no symbol, and every money
 * column is labelled "(INR)". This also keeps the file free of embedded fonts,
 * so exports stay small.
 *
 * `pdfkit` reads its built-in font metrics from disk at runtime, so it is
 * declared in `serverExternalPackages` in next.config.ts — bundling it breaks
 * that lookup.
 */

// Wezo brand lime, from the live site's gradient.
const LIME = "#ABCC15";
const INK = "#0A0A0A";
const MUTED = "#6B6B6B";
const HAIRLINE = "#D8D8D8";
const ZEBRA = "#F6F6F6";

const PAGE_MARGIN = 40;
const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const inrGroup = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "12,34,567.00" — Indian grouping, no symbol (see font note above). */
function moneyForPdf(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? inrGroup.format(n) : String(value);
}

function cellText(row: ReportRow, column: ReportColumn): string {
  const raw = row[column.key];
  if (raw === null || raw === undefined || raw === "") return "";
  switch (column.kind) {
    case "money":
      return moneyForPdf(raw);
    case "percent":
      return `${raw}%`;
    case "date":
      return formatDate(String(raw));
    case "int":
      return String(raw);
    default:
      return String(raw);
  }
}

function isNumeric(column: ReportColumn): boolean {
  return (
    column.kind === "money" ||
    column.kind === "percent" ||
    column.kind === "int"
  );
}

type Doc = PDFKit.PDFDocument;

/** Draws the lime W mark plus the wordmark, matching the app header. */
function drawBrand(doc: Doc, x: number, y: number): void {
  const w = 20;
  const h = 14;
  doc
    .save()
    .lineWidth(2.4)
    .strokeColor(LIME)
    .lineJoin("round")
    .lineCap("round")
    .moveTo(x, y)
    .lineTo(x + w * 0.28, y + h)
    .lineTo(x + w * 0.5, y + h * 0.45)
    .lineTo(x + w * 0.72, y + h)
    .lineTo(x + w, y)
    .stroke()
    .restore();

  doc
    .font(FONT_BOLD)
    .fontSize(13)
    .fillColor(INK)
    .text("wezo", x + w + 7, y + 1);
}

function drawHeader(doc: Doc, report: Report): void {
  const { left, right } = { left: PAGE_MARGIN, right: doc.page.width - PAGE_MARGIN };

  drawBrand(doc, left, PAGE_MARGIN);

  doc
    .font(FONT)
    .fontSize(8)
    .fillColor(MUTED)
    .text("Wezo Technologies", right - 200, PAGE_MARGIN + 1, {
      width: 200,
      align: "right",
    })
    .text("Expense & Income Tracker", right - 200, PAGE_MARGIN + 11, {
      width: 200,
      align: "right",
    });

  let y = PAGE_MARGIN + 36;

  doc.font(FONT_BOLD).fontSize(18).fillColor(INK).text(report.title, left, y);
  y = doc.y + 4;

  doc.font(FONT).fontSize(10).fillColor(INK).text(report.periodLabel, left, y);
  y = doc.y + 2;

  doc.fontSize(8).fillColor(MUTED).text(report.basisNote, left, y, {
    width: right - left,
  });
  y = doc.y + 1;

  doc.text(
    `Generated ${formatDateTime(report.generatedAt)} IST by ${report.generatedByName}`,
    left,
    y,
    { width: right - left },
  );
  y = doc.y;

  for (const note of report.filterNotes) {
    doc.text(note, left, doc.y, { width: right - left });
  }

  y = doc.y + 10;
  doc
    .save()
    .strokeColor(LIME)
    .lineWidth(2)
    .moveTo(left, y)
    .lineTo(left + 46, y)
    .stroke()
    .restore();

  doc.y = y + 12;
}

function drawSummary(doc: Doc, report: Report): void {
  if (report.summary.length === 0) return;

  const left = PAGE_MARGIN;
  const usable = doc.page.width - PAGE_MARGIN * 2;
  const gap = 10;
  const count = report.summary.length;
  const boxWidth = (usable - gap * (count - 1)) / count;
  const boxHeight = 44;
  const top = doc.y;

  report.summary.forEach((tile, i) => {
    const x = left + i * (boxWidth + gap);
    doc
      .save()
      .roundedRect(x, top, boxWidth, boxHeight, 5)
      .lineWidth(0.7)
      .strokeColor(HAIRLINE)
      .stroke()
      .restore();

    doc
      .font(FONT)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(tile.label.toUpperCase(), x + 9, top + 9, {
        width: boxWidth - 18,
        characterSpacing: 0.4,
      });

    doc
      .font(FONT_BOLD)
      .fontSize(13)
      .fillColor(INK)
      .text(tileValue(tile), x + 9, top + 22, {
        width: boxWidth - 18,
        lineBreak: false,
      });
  });

  doc.y = top + boxHeight + 16;
}

/**
 * A tile holds either money or a plain count. Counts must stay bare — a
 * "Clients" tile reading "1.00" looks like a currency amount.
 */
function tileValue(tile: SummaryTile): string {
  if (tile.kind === "count") return tile.value;
  return /^-?\d+(\.\d+)?$/.test(tile.value) ? moneyForPdf(tile.value) : tile.value;
}

/** Proportional column widths, weighted by kind and label length. */
function computeWidths(table: ReportTable, usable: number): number[] {
  const weights = table.columns.map((c) => {
    if (c.kind === "money") return 1.15;
    if (c.kind === "percent") return 0.7;
    if (c.kind === "int") return 0.6;
    if (c.kind === "date") return 0.85;
    // Text columns get more room, scaled a little by their header length.
    return Math.min(2.4, 1.4 + c.label.length / 40);
  });
  const totalWeight = weights.reduce((a, w) => a + w, 0);
  return weights.map((w) => (w / totalWeight) * usable);
}

function drawTable(doc: Doc, table: ReportTable, report: Report): void {
  const left = PAGE_MARGIN;
  const usable = doc.page.width - PAGE_MARGIN * 2;
  const widths = computeWidths(table, usable);
  const rowPadding = 5;

  if (table.title) {
    ensureSpace(doc, 40, report);
    doc
      .font(FONT_BOLD)
      .fontSize(10.5)
      .fillColor(INK)
      .text(table.title, left, doc.y);
    doc.y += 4;
  }

  const drawHeadRow = () => {
    const y = doc.y;
    const height = 20;
    doc.save().rect(left, y, usable, height).fillColor("#EFEFEF").fill().restore();

    let x = left;
    table.columns.forEach((column, i) => {
      doc
        .font(FONT_BOLD)
        .fontSize(7.6)
        .fillColor(INK)
        .text(column.label.toUpperCase(), x + rowPadding, y + 6.5, {
          width: widths[i] - rowPadding * 2,
          align: isNumeric(column) ? "right" : "left",
          lineBreak: false,
          characterSpacing: 0.2,
        });
      x += widths[i];
    });

    doc.y = y + height;
  };

  ensureSpace(doc, 60, report);
  drawHeadRow();

  if (table.rows.length === 0) {
    doc
      .font(FONT)
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(table.emptyMessage ?? "No data", left + rowPadding, doc.y + 7, {
        width: usable - rowPadding * 2,
      });
    doc.y += 24;
    return;
  }

  const drawBodyRow = (row: ReportRow, index: number, bold = false) => {
    // Measure the tallest cell so wrapped text doesn't overlap the next row.
    const heights = table.columns.map((column, i) => {
      const text = cellText(row, column);
      if (!text) return 11;
      return doc
        .font(bold ? FONT_BOLD : FONT)
        .fontSize(8.5)
        .heightOfString(text, { width: widths[i] - rowPadding * 2 });
    });
    const rowHeight = Math.max(11, ...heights) + rowPadding * 2;

    if (!ensureSpace(doc, rowHeight + 6, report)) {
      drawHeadRow();
    }

    const y = doc.y;

    if (bold) {
      doc.save().rect(left, y, usable, rowHeight).fillColor("#EDEFE3").fill().restore();
    } else if (index % 2 === 1) {
      doc.save().rect(left, y, usable, rowHeight).fillColor(ZEBRA).fill().restore();
    }

    let x = left;
    table.columns.forEach((column, i) => {
      doc
        .font(bold ? FONT_BOLD : FONT)
        .fontSize(8.5)
        .fillColor(INK)
        .text(cellText(row, column), x + rowPadding, y + rowPadding, {
          width: widths[i] - rowPadding * 2,
          align: isNumeric(column) ? "right" : "left",
        });
      x += widths[i];
    });

    doc.y = y + rowHeight;
    doc
      .save()
      .strokeColor(HAIRLINE)
      .lineWidth(0.4)
      .moveTo(left, doc.y)
      .lineTo(left + usable, doc.y)
      .stroke()
      .restore();
  };

  table.rows.forEach((row, i) => drawBodyRow(row, i));
  if (table.total) drawBodyRow(table.total, table.rows.length, true);

  doc.y += 14;
}

/**
 * Returns false (after adding a page) when the remaining space is too small,
 * so callers can re-draw a table header on the new page.
 */
function ensureSpace(doc: Doc, needed: number, report: Report): boolean {
  const bottom = doc.page.height - PAGE_MARGIN - 24;
  if (doc.y + needed <= bottom) return true;
  doc.addPage();
  drawContinuationHeader(doc, report);
  return false;
}

function drawContinuationHeader(doc: Doc, report: Report): void {
  drawBrand(doc, PAGE_MARGIN, PAGE_MARGIN - 6);
  doc
    .font(FONT)
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      `${report.title} · ${report.periodLabel} (continued)`,
      PAGE_MARGIN + 90,
      PAGE_MARGIN - 2,
      { width: doc.page.width - PAGE_MARGIN * 2 - 90, align: "right" },
    );
  doc.y = PAGE_MARGIN + 22;
}

function drawMemos(doc: Doc, report: Report): void {
  if (report.memos.length === 0) return;

  ensureSpace(doc, 60, report);
  const left = PAGE_MARGIN;
  const usable = doc.page.width - PAGE_MARGIN * 2;

  doc.font(FONT_BOLD).fontSize(9).fillColor(INK).text("Notes", left, doc.y);
  doc.y += 3;

  for (const memo of report.memos) {
    const height = doc.font(FONT).fontSize(8).heightOfString(memo, {
      width: usable - 16,
    });
    ensureSpace(doc, height + 16, report);

    const y = doc.y;
    doc
      .save()
      .rect(left, y, 2.5, height + 10)
      .fillColor(LIME)
      .fill()
      .restore();

    doc
      .font(FONT)
      .fontSize(8)
      .fillColor(MUTED)
      .text(memo, left + 10, y + 5, { width: usable - 16 });

    doc.y = y + height + 14;
  }
}

/**
 * Page numbers, added after layout so the total count is known.
 *
 * The footer sits inside the bottom margin. pdfkit auto-inserts a new page when
 * text crosses that margin, which would append a blank page per footer — so the
 * bottom margin is zeroed for the write and the page count is captured first.
 */
function paginate(doc: Doc): void {
  const range = doc.bufferedPageRange();
  const total = range.count;

  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;

    doc
      .font(FONT)
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        `Page ${i - range.start + 1} of ${total}`,
        PAGE_MARGIN,
        doc.page.height - PAGE_MARGIN + 2,
        {
          width: doc.page.width - PAGE_MARGIN * 2,
          align: "center",
          lineBreak: false,
        },
      );
  }
}

/** Renders a report to a PDF buffer. */
export async function reportToPdf(report: Report): Promise<Buffer> {
  // Wide tables get landscape so columns stay readable.
  const wide = report.tables.some((t) => t.columns.length > 6);

  const doc = new PDFDocument({
    size: "A4",
    layout: wide ? "landscape" : "portrait",
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: {
      Title: `Wezo ${report.title} — ${report.periodLabel}`,
      Author: "Wezo Expense Tracker",
      Subject: report.basisNote,
      Creator: "Wezo Expense & Income Tracker",
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawHeader(doc, report);
  drawSummary(doc, report);
  for (const table of report.tables) drawTable(doc, table, report);
  drawMemos(doc, report);
  paginate(doc);

  doc.end();
  return finished;
}

export function pdfResponse(pdf: Buffer, filename: string): Response {
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(pdf.length),
      "cache-control": "private, no-store",
    },
  });
}
