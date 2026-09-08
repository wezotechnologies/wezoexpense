"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Spinner,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { IconUpload } from "@/components/icons";
import { formatInr } from "@/lib/format";

/**
 * Bulk CSV import (spec 11): validate with Zod, preview, then commit.
 *
 * The preview is advisory only — commit re-parses and re-validates the same CSV
 * on the server, so nothing here can be edited into bypassing a rule.
 */

type PreviewRow = {
  line: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  raw: Record<string, string>;
  parsed: { type: string; date: string; amountInr: string } | null;
};

type Preview = {
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

const TEMPLATE = `type,date,amountInr,category,vendor,paymentMethod,paymentLabel,notes,originalCurrency,originalAmount,routing
expense,2026-04-05,35000.00,Rent,Kanpur Office,Bank transfer,,Office rent April,,,
income,2026-04-12,20000.00,Client Work,Acme Pvt Ltd,Bank transfer,1st payment,Milestone 1,USD,200.00,DIRECT
income,2026-04-20,47500.00,Client Work,Gulf Retail LLC,Bank transfer,Advance,Collected in Dubai,AED,2000.00,VIA_DUBAI_PARTNER`;

export function ImportWizard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [approve, setApprove] = useState(false);
  const [createVendors, setCreateVendors] = useState(true);

  async function post(mode: "preview" | "commit") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          csv,
          approve,
          createMissingVendors: createVendors,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "That file could not be processed.");
        return;
      }

      if (mode === "preview") {
        setPreview(data.preview);
        setResult(null);
      } else {
        setResult(
          `Imported ${data.result.created} transaction${data.result.created === 1 ? "" : "s"} as ${data.result.status.toLowerCase()}${
            data.result.vendorsCreated > 0
              ? `, and added ${data.result.vendorsCreated} new vendor${data.result.vendorsCreated === 1 ? "" : "s"}`
              : ""
          }.${data.result.skipped > 0 ? ` ${data.result.skipped} row(s) were skipped.` : ""}`,
        );
        setPreview(null);
        setCsv("");
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function readFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ""));
      setPreview(null);
      setResult(null);
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-4">
      {result ? <Alert tone="success">{result}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <CardHeader
          title="1. Paste or upload your CSV"
          description="The first row must be headers. Column names are matched automatically."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCsv(TEMPLATE);
                setPreview(null);
              }}
            >
              Use a sample
            </Button>
          }
        />
        <div className="space-y-3 p-4">
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileRef.current?.click()}
          >
            <IconUpload className="h-4 w-4" />
            Choose a .csv file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) readFile(file);
              e.target.value = "";
            }}
          />

          <Textarea
            rows={8}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
            }}
            placeholder="type,date,amountInr,category,vendor,notes&#10;expense,2026-04-05,35000.00,Rent,Kanpur Office,Office rent April"
            className="font-mono text-[11px]"
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy || csv.trim().length === 0}
              onClick={() => post("preview")}
            >
              {busy ? <Spinner /> : null}
              Check the file
            </Button>
            {csv ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCsv("");
                  setPreview(null);
                  setResult(null);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>

          <details className="text-[11px] text-ink-muted">
            <summary className="cursor-pointer">Which columns are understood?</summary>
            <div className="mt-2 space-y-1">
              <p>
                <strong className="text-ink">Required:</strong> type (income or
                expense), date (YYYY-MM-DD), amountInr.
              </p>
              <p>
                <strong className="text-ink">Optional:</strong> category, vendor,
                paymentMethod, paymentLabel, notes, originalCurrency,
                originalAmount, routing (DIRECT or VIA_DUBAI_PARTNER).
              </p>
              <p>
                Common alternative spellings are accepted — &quot;Transaction
                Date&quot;, &quot;Amount (INR)&quot;, &quot;Narration&quot;,
                &quot;Payee&quot; and similar all map correctly.
              </p>
            </div>
          </details>
        </div>
      </Card>

      {preview ? (
        <Card>
          <CardHeader
            title="2. Check what will happen"
            description="Nothing has been saved yet."
          />

          <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
            <Stat label="Ready to import" value={String(preview.validCount)} tone="income" />
            <Stat
              label="With problems"
              value={String(preview.errorCount)}
              tone={preview.errorCount > 0 ? "expense" : "neutral"}
            />
            <Stat label="Income total" value={formatInr(preview.totals.income)} />
            <Stat label="Expense total" value={formatInr(preview.totals.expense)} />
          </div>

          <div className="space-y-3 border-t border-line p-4">
            {preview.missingRequired.length > 0 ? (
              <Alert tone="error" title="Missing required columns">
                {preview.missingRequired.join(", ")} — add these headers and try
                again.
              </Alert>
            ) : null}

            {preview.lockedMonths.length > 0 ? (
              <Alert tone="warning" title="Closed months">
                Some rows fall in {preview.lockedMonths.join(", ")}, which
                {preview.lockedMonths.length === 1 ? " has" : " have"} been closed.
                Reopen the month or remove those rows.
              </Alert>
            ) : null}

            {preview.unmappedHeaders.length > 0 ? (
              <Alert tone="info" title="Ignored columns">
                {preview.unmappedHeaders.join(", ")} — these are not recognised and
                will be skipped.
              </Alert>
            ) : null}

            {preview.newVendors.length > 0 ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={createVendors}
                  onChange={(e) => setCreateVendors(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-line bg-surface-2 accent-[var(--accent)]"
                />
                <span className="text-xs text-ink-muted">
                  Add {preview.newVendors.length} new name
                  {preview.newVendors.length === 1 ? "" : "s"} to the vendor
                  directory: {preview.newVendors.slice(0, 6).join(", ")}
                  {preview.newVendors.length > 6 ? "…" : ""}
                </span>
              </label>
            ) : null}

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={approve}
                onChange={(e) => setApprove(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-line bg-surface-2 accent-[var(--accent)]"
              />
              <span className="text-xs text-ink-muted">
                Mark these as approved. Historical books are usually already
                settled, so this is normally what you want. Leave it off to send
                them through the approval queue.
              </span>
            </label>
          </div>

          <div className="max-h-80 overflow-auto border-t border-line">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line text-left uppercase tracking-wide text-ink-muted">
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Notes on this row</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {preview.rows.slice(0, 200).map((row) => (
                  <tr key={row.line} className={cx(!row.ok && "bg-expense/5")}>
                    <td className="px-3 py-1.5 text-ink-muted tabular">{row.line}</td>
                    <td className="px-3 py-1.5">
                      {row.parsed ? (
                        <Badge tone={row.parsed.type === "INCOME" ? "income" : "expense"}>
                          {row.parsed.type === "INCOME" ? "In" : "Out"}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-1.5 tabular">{row.parsed?.date ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular">
                      {row.parsed ? formatInr(row.parsed.amountInr) : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      {row.errors.length > 0 ? (
                        <span className="text-expense">{row.errors.join(" ")}</span>
                      ) : row.warnings.length > 0 ? (
                        <span className="text-pending">{row.warnings.join(" ")}</span>
                      ) : (
                        <span className="text-income">Ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 200 ? (
              <p className="px-3 py-2 text-center text-[11px] text-ink-muted">
                Showing the first 200 of {preview.rows.length} rows.
              </p>
            ) : null}
          </div>

          <div className="border-t border-line p-4">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              disabled={busy || preview.validCount === 0}
              onClick={() => post("commit")}
            >
              {busy ? <Spinner /> : null}
              Import {preview.validCount} transaction
              {preview.validCount === 1 ? "" : "s"}
              {preview.errorCount > 0
                ? ` (skipping ${preview.errorCount} with problems)`
                : ""}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "income" | "expense" | "neutral";
}) {
  return (
    <div className="px-4 py-3">
      <p className="text-[11px] text-ink-muted">{label}</p>
      <p
        className={cx(
          "mt-0.5 text-base font-semibold tabular",
          tone === "income" && "text-income",
          tone === "expense" && "text-expense",
        )}
      >
        {value}
      </p>
    </div>
  );
}
