"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  Alert,
  Button,
  Spinner,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { IconDownload, IconFile, IconTrash, IconX } from "@/components/icons";
import { AiBadge, AmountCell, RoutingBadge, StatusBadge } from "@/components/txn-bits";
import {
  formatDate,
  formatDateTime,
  formatForeign,
  formatFxRate,
  formatInr,
  titleCase,
} from "@/lib/format";
import type { TransactionDTO } from "@/lib/transactions";

type AuditEntry = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
};

/**
 * Transaction detail (spec 9.4): the receipt beside the parsed fields, the full
 * record, its audit trail, and the actions the viewer is allowed to take.
 *
 * Opened by `?id=` so a row is linkable and the browser back button closes it.
 */
export function TxnDetailDrawer(props: {
  canApprove: boolean;
  canDelete: boolean;
  currentUserId: string;
}) {
  const params = useSearchParams();
  const id = params.get("id");

  // Keyed on the id so opening a different row remounts with fresh state,
  // rather than an effect having to reset half a dozen useStates.
  if (!id) return null;
  return <DrawerContent key={id} id={id} {...props} />;
}

function DrawerContent({
  id,
  canApprove,
  canDelete,
  currentUserId,
}: {
  id: string;
  canApprove: boolean;
  canDelete: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const [txn, setTxn] = useState<TransactionDTO | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const close = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.delete("id");
    router.push(`/transactions${next.toString() ? `?${next}` : ""}`, {
      scroll: false,
    });
  }, [params, router]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/transactions/${id}`);
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;

        if (!response.ok) {
          setError(data.error ?? "Could not load that transaction.");
          setTxn(null);
          return;
        }
        setTxn(data);

        // The audit feed is admin-only; a failure here is not worth surfacing.
        const auditResponse = await fetch(
          `/api/audit?entity=Transaction&entityId=${id}&perPage=20`,
        );
        if (auditResponse.ok && !cancelled) {
          const auditData = await auditResponse.json();
          setAudit(auditData.entries ?? []);
        }
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  async function act(path: string, body?: unknown) {
    if (!txn) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/transactions/${txn.id}${path}`, {
        method: path === "" ? "DELETE" : "POST",
        ...(body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "That action could not be completed.");
        return;
      }

      router.refresh();
      if (path === "") close();
      else setTxn(data);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const isOwn = txn?.createdById === currentUserId;
  const canReview = canApprove && txn?.status === "PENDING" && !isOwn;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close details"
        onClick={close}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />

      <aside
        role="dialog"
        aria-label="Transaction details"
        aria-modal="true"
        className="relative flex h-full w-full max-w-lg flex-col border-l border-line bg-canvas shadow-2xl"
      >
        {/* Full-height overlay, so it draws under the status bar in an
            installed PWA just as the app header does — and Close is the only
            way out of a modal dialog. Inset added to the padding, not replacing
            it, so nothing shifts on a device without a notch. */}
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <h2 className="text-sm font-semibold">Transaction</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="h-5 w-5 text-accent" />
            </div>
          ) : error && !txn ? (
            <div className="p-4">
              <Alert tone="error">{error}</Alert>
            </div>
          ) : txn ? (
            <div className="space-y-4 p-4">
              {error ? <Alert tone="error">{error}</Alert> : null}

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <AmountCell
                    type={txn.type}
                    amountInr={txn.amountInr}
                    className="text-xl"
                  />
                  <p className="mt-1 text-xs text-ink-muted">
                    {formatDate(txn.date)}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <StatusBadge status={txn.status} />
                  <RoutingBadge routing={txn.routing} />
                  <AiBadge extracted={txn.aiExtracted} confidence={txn.aiConfidence} />
                </div>
              </div>

              {txn.status === "REJECTED" && txn.rejectionReason ? (
                <Alert tone="error" title="Rejected">
                  {txn.rejectionReason}
                </Alert>
              ) : null}

              {txn.periodLocked ? (
                <Alert tone="warning">
                  This month has been closed. Only a Superadmin can change it.
                </Alert>
              ) : null}

              {/* Receipt beside the parsed fields (spec 9.5) */}
              {txn.hasReceipt ? (
                <div className="overflow-hidden rounded-lg border border-line">
                  {txn.receiptMime === "application/pdf" ? (
                    <a
                      href={`/api/receipt/${txn.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 bg-surface p-4 hover:bg-surface-2"
                    >
                      <IconFile className="h-5 w-5 text-ink-muted" />
                      <span className="text-xs">Open the PDF receipt</span>
                    </a>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element -- served through an authorised route that 302s to a short-lived SAS */
                    <img
                      src={`/api/receipt/${txn.id}`}
                      alt="Receipt"
                      className="max-h-80 w-full bg-surface object-contain"
                    />
                  )}
                  <a
                    href={`/api/receipt/${txn.id}?download=1`}
                    className="flex items-center justify-center gap-1.5 border-t border-line bg-surface py-2 text-xs text-ink-muted hover:text-ink"
                  >
                    <IconDownload className="h-3.5 w-3.5" />
                    Download receipt
                  </a>
                </div>
              ) : null}

              <dl className="divide-y divide-line rounded-lg border border-line">
                <Row label="Category" value={txn.categoryName} />
                <Row
                  label={txn.type === "INCOME" ? "Client" : "Vendor"}
                  value={txn.vendorName}
                />
                <Row label="Project" value={txn.projectName} />
                <Row label="Payment label" value={txn.paymentLabel} />
                <Row label="Payment method" value={txn.paymentMethod} />

                {txn.originalAmount ? (
                  <>
                    <Row
                      label="Original amount"
                      value={formatForeign(txn.originalAmount, txn.originalCurrency)}
                      hint="For reference — only the INR figure is booked."
                    />
                    <Row label="Exchange rate" value={formatFxRate(txn.fxRate)} />
                  </>
                ) : null}

                {txn.routing === "VIA_DUBAI_PARTNER" ? (
                  <>
                    <Row
                      label="Gross paid to partner"
                      value={formatForeign(txn.grossAmount, txn.grossCurrency)}
                    />
                    <Row
                      label="VAT handled by partner"
                      value={formatForeign(txn.vatAmount, txn.vatCurrency)}
                      hint="Not counted as Wezo income."
                    />
                  </>
                ) : null}

                {txn.taxAmount ? (
                  <Row label="Tax included" value={formatInr(txn.taxAmount)} />
                ) : null}

                <Row label="Submitted by" value={txn.createdByName} />
                {txn.reviewedByName ? (
                  <Row
                    label="Reviewed by"
                    value={`${txn.reviewedByName}${txn.reviewedAt ? ` · ${formatDate(txn.reviewedAt)}` : ""}`}
                  />
                ) : null}
              </dl>

              {txn.notes ? (
                <div className="rounded-lg border border-line bg-surface p-3">
                  <p className="mb-1 text-[11px] font-medium text-ink-muted">Notes</p>
                  <p className="whitespace-pre-wrap text-sm">{txn.notes}</p>
                </div>
              ) : null}

              {audit.length > 0 ? (
                <div className="rounded-lg border border-line bg-surface p-3">
                  <p className="mb-2 text-[11px] font-medium text-ink-muted">
                    Audit trail
                  </p>
                  <ul className="space-y-1.5">
                    {audit.map((entry) => (
                      <li key={entry.id} className="flex gap-2 text-[11px]">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
                        <span className="text-ink-muted">
                          <span className="text-ink">{titleCase(entry.action)}</span>{" "}
                          by {entry.actorName} · {formatDateTime(entry.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {txn ? (
          <footer className="border-t border-line p-3">
            {rejecting ? (
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
                    className="flex-1"
                    onClick={() => setRejecting(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    className="flex-1"
                    disabled={busy || reason.trim().length < 3}
                    onClick={() => act("/reject", { reason: reason.trim() })}
                  >
                    {busy ? <Spinner /> : null}
                    Confirm rejection
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {canReview ? (
                  <>
                    <Button
                      variant="success"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => act("/approve")}
                    >
                      {busy ? <Spinner /> : null}
                      Approve
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => setRejecting(true)}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}

                {canApprove && txn.status === "PENDING" && isOwn ? (
                  <p className="w-full text-center text-[11px] text-ink-muted">
                    You submitted this, so another approver needs to review it.
                  </p>
                ) : null}

                {canDelete && !txn.periodLocked ? (
                  <Button
                    variant="ghost"
                    className={cx(canReview ? "w-full" : "flex-1")}
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          "Delete this transaction? It will be removed from reports but kept in the audit log.",
                        )
                      ) {
                        void act("");
                      }
                    }}
                  >
                    <IconTrash className="h-4 w-4" />
                    Delete
                  </Button>
                ) : null}
              </div>
            )}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className="block text-sm">{value}</span>
        {hint ? (
          <span className="mt-0.5 block text-[10px] text-ink-muted/80">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}
