"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  Spinner,
  Textarea,
} from "@/components/ui/primitives";
import { IconFile } from "@/components/icons";
import { AiBadge, AmountCell, RoutingBadge } from "@/components/txn-bits";
import {
  formatDate,
  formatForeign,
  formatFxRate,
  formatInr,
} from "@/lib/format";
import type { TransactionDTO } from "@/lib/transactions";

/**
 * One item in the approval queue (spec 7.3, 9.5): the receipt beside the parsed
 * fields, so a reviewer can check the figures against the document without
 * leaving the page. Rejecting requires a reason.
 */
export function ApprovalCard({
  txn,
  isOwn,
}: {
  txn: TransactionDTO;
  isOwn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);

  async function act(kind: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/transactions/${txn.id}/${kind}`, {
        method: "POST",
        ...(kind === "reject"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: reason.trim() }),
            }
          : {}),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "That action could not be completed.");
        return;
      }

      setDone(kind === "approve" ? "approved" : "rejected");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card className="flex items-center gap-3 border-dashed p-4">
        <Badge tone={done === "approved" ? "approved" : "rejected"}>
          {done === "approved" ? "Approved" : "Rejected"}
        </Badge>
        <span className="text-xs text-ink-muted">
          {formatInr(txn.amountInr)} · {txn.createdByName}
        </span>
      </Card>
    );
  }

  const foreign = formatForeign(txn.originalAmount, txn.originalCurrency);

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-0 sm:grid-cols-[minmax(0,220px)_1fr]">
        {/* Receipt */}
        <div className="border-b border-line bg-surface-2/50 sm:border-b-0 sm:border-r">
          {txn.hasReceipt ? (
            txn.receiptMime === "application/pdf" ? (
              <a
                href={`/api/receipt/${txn.id}`}
                target="_blank"
                rel="noreferrer"
                className="flex h-full min-h-32 flex-col items-center justify-center gap-2 p-4 text-ink-muted hover:text-ink"
              >
                <IconFile className="h-6 w-6" />
                <span className="text-[11px]">Open PDF</span>
              </a>
            ) : (
              <a href={`/api/receipt/${txn.id}`} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- authorised route, short-lived SAS */}
                <img
                  src={`/api/receipt/${txn.id}`}
                  alt={`Receipt for ${formatInr(txn.amountInr)}`}
                  className="h-full max-h-56 w-full object-contain p-2"
                />
              </a>
            )
          ) : (
            <div className="flex h-full min-h-32 items-center justify-center p-4">
              <p className="text-center text-[11px] text-ink-muted">
                No receipt attached
              </p>
            </div>
          )}
        </div>

        {/* Parsed fields */}
        <div className="min-w-0 p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <AmountCell type={txn.type} amountInr={txn.amountInr} className="text-lg" />
              <p className="mt-0.5 text-xs text-ink-muted">
                {formatDate(txn.date)} · submitted by {txn.createdByName}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-1.5">
              <RoutingBadge routing={txn.routing} />
              <AiBadge extracted={txn.aiExtracted} confidence={txn.aiConfidence} />
            </div>
          </div>

          <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Pair label="Category" value={txn.categoryName} />
            <Pair
              label={txn.type === "INCOME" ? "Client" : "Vendor"}
              value={txn.vendorName}
            />
            <Pair label="Payment" value={txn.paymentMethod} />
            <Pair label="Label" value={txn.paymentLabel} />
            {foreign ? <Pair label="Original" value={foreign} /> : null}
            {txn.fxRate ? <Pair label="FX rate" value={formatFxRate(txn.fxRate)} /> : null}
            {txn.routing === "VIA_DUBAI_PARTNER" ? (
              <Pair
                label="VAT (partner)"
                value={formatForeign(txn.vatAmount, txn.vatCurrency)}
              />
            ) : null}
          </dl>

          {txn.notes ? (
            <p className="mb-3 rounded-lg bg-surface-2 px-2.5 py-2 text-xs text-ink-muted">
              {txn.notes}
            </p>
          ) : null}

          {txn.routing === "VIA_DUBAI_PARTNER" ? (
            <Alert tone="info" className="mb-3">
              Only the net {formatInr(txn.amountInr)} received in India is booked as
              income. The partner&apos;s VAT is a memo and is excluded from revenue.
            </Alert>
          ) : null}

          {error ? (
            <Alert tone="error" className="mb-3">
              {error}
            </Alert>
          ) : null}

          {isOwn ? (
            <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] text-ink-muted">
              You submitted this, so another approver needs to review it.
            </p>
          ) : rejecting ? (
            <div className="space-y-2">
              <Textarea
                autoFocus
                rows={2}
                placeholder="Why is this being rejected? The submitter will see this."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRejecting(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  className="flex-1"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => act("reject")}
                >
                  {busy ? <Spinner /> : null}
                  Confirm rejection
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="success"
                size="sm"
                className="flex-1"
                disabled={busy}
                onClick={() => act("approve")}
              >
                {busy ? <Spinner /> : null}
                Approve
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                Reject
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Pair({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-ink-muted/70">
        {label}
      </dt>
      <dd className="truncate">{value ?? "—"}</dd>
    </div>
  );
}
