"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Spinner,
  cx,
} from "@/components/ui/primitives";
import {
  IconCamera,
  IconFile,
  IconSparkle,
  IconUpload,
  IconX,
} from "@/components/icons";
import {
  TransactionForm,
  emptyFormValues,
  type FieldConfidence,
  type RefData,
  type TransactionFormValues,
} from "@/components/transaction-form";
import { enqueue } from "@/lib/offline-queue";

/**
 * Add / Upload (spec 7.1, 7.2, 8.3).
 *
 * Flow: pick a file (camera or library) -> upload to private storage -> ask the
 * model to read it -> pre-fill the form -> the user corrects anything -> save.
 *
 * Every step degrades: no AI configured, an unreadable scan, a spent budget or
 * a network failure all land on the same fully-usable manual form. The receipt
 * is optional throughout — "manual entry works fully with no image".
 *
 * When offline, the transaction and its image are queued in IndexedDB and sent
 * when connectivity returns.
 */

type Stage = "choose" | "reading" | "form";

type ExtractResponse = {
  ok: boolean;
  band: "high" | "verify" | "low";
  notice: string | null;
  draft: {
    type: "income" | "expense" | "unknown";
    date: string | null;
    vendor: string | null;
    originalCurrency: string | null;
    originalAmount: number | null;
    amountInr: number | null;
    taxOrVatAmount: number | null;
    paymentMethod: string | null;
    suggestedCategory: string | null;
    confidence: number;
    fieldConfidence: FieldConfidence;
    reasoning: string;
  } | null;
  raw: unknown;
  aiConfidence: number | null;
  budget: { exhausted: boolean; remainingUsd: number };
};

const MAX_BYTES = 10 * 1024 * 1024;

export function AddFlow({
  refData,
  canApprove,
  vatEnabled,
  approvalRequired,
  aiConfigured,
  today,
}: {
  refData: RefData;
  canApprove: boolean;
  vatEnabled: boolean;
  approvalRequired: boolean;
  aiConfigured: boolean;
  today: string;
}) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("choose");
  const [values, setValues] = useState<TransactionFormValues>(() =>
    emptyFormValues(today),
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fieldConfidence, setFieldConfidence] = useState<FieldConfidence | null>(null);
  const [aiExtracted, setAiExtracted] = useState(false);
  const [aiRaw, setAiRaw] = useState<unknown>(null);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [queued, setQueued] = useState(false);

  function reset() {
    setStage("choose");
    setValues(emptyFormValues(today));
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setPendingFile(null);
    setFieldConfidence(null);
    setAiExtracted(false);
    setAiRaw(null);
    setAiConfidence(null);
    setNotice(null);
    setError(null);
    setQueued(false);
  }

  /** Maps the model's draft onto the form, resolving names to ids. */
  function applyDraft(draft: NonNullable<ExtractResponse["draft"]>) {
    const type: "INCOME" | "EXPENSE" =
      draft.type === "income" ? "INCOME" : "EXPENSE";

    const category = draft.suggestedCategory
      ? refData.categories.find(
          (c) =>
            c.type === type &&
            c.name.toLowerCase() === draft.suggestedCategory!.toLowerCase(),
        )
      : undefined;

    const vendor = draft.vendor
      ? refData.vendors.find(
          (v) => v.name.toLowerCase() === draft.vendor!.toLowerCase(),
        )
      : undefined;

    // The model returns amountInr only when the document actually shows a rupee
    // figure. Otherwise the original amount is all we have, and the user tells
    // us what landed in the bank — we never invent a conversion.
    const amountInr =
      draft.amountInr !== null
        ? String(draft.amountInr)
        : draft.originalCurrency === "INR" && draft.originalAmount !== null
          ? String(draft.originalAmount)
          : "";

    const foreign =
      draft.originalCurrency && draft.originalCurrency !== "INR"
        ? {
            originalCurrency: draft.originalCurrency,
            originalAmount:
              draft.originalAmount !== null ? String(draft.originalAmount) : "",
          }
        : { originalCurrency: "", originalAmount: "" };

    setValues((prev) => ({
      ...prev,
      type,
      date: draft.date ?? prev.date,
      amountInr,
      ...foreign,
      categoryId: category?.id ?? "",
      vendorId: vendor?.id ?? "",
      paymentMethod: draft.paymentMethod ?? "",
      taxAmount:
        type === "EXPENSE" && draft.taxOrVatAmount !== null
          ? String(draft.taxOrVatAmount)
          : "",
      notes:
        !vendor && draft.vendor
          ? `From receipt: ${draft.vendor}`
          : prev.notes,
    }));
  }

  async function handleFile(file: File) {
    setError(null);
    setNotice(null);

    if (file.size > MAX_BYTES) {
      setError("That file is larger than 10 MB. Try a smaller photo.");
      return;
    }

    const objectUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    setPreview(objectUrl);
    setPendingFile(file);

    // Offline: skip straight to the manual form and queue on save.
    if (!navigator.onLine) {
      setNotice(
        "You're offline, so the receipt can't be read yet. Fill in the details and it will sync — image and all — once you're back online.",
      );
      setStage("form");
      return;
    }

    setStage("reading");

    try {
      const form = new FormData();
      form.append("file", file);

      const uploadResponse = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });
      const uploaded = await uploadResponse.json().catch(() => ({}));

      if (!uploadResponse.ok) {
        setError(uploaded.error ?? "Could not upload that file.");
        setStage("form");
        return;
      }

      setValues((prev) => ({
        ...prev,
        receiptBlobKey: uploaded.blobKey,
        receiptMime: uploaded.mime,
      }));
      setPendingFile(null); // it is stored server-side now

      if (!aiConfigured) {
        setNotice(
          "Receipt saved. AI reading isn't set up on this deployment, so please fill in the details.",
        );
        setStage("form");
        return;
      }

      const extractResponse = await fetch("/api/ai/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blobKey: uploaded.blobKey, mime: uploaded.mime }),
      });
      const result: ExtractResponse = await extractResponse.json();

      if (!extractResponse.ok) {
        setNotice(
          (result as unknown as { error?: string }).error ??
            "AI reading is unavailable — please fill in the details.",
        );
        setStage("form");
        return;
      }

      if (result.draft) {
        applyDraft(result.draft);
        setAiExtracted(true);
        setAiRaw(result.raw);
        setAiConfidence(result.aiConfidence);
        // Only flag individual fields when the read was shaky overall.
        setFieldConfidence(result.band === "high" ? null : result.draft.fieldConfidence);
      }
      setNotice(result.notice);
      setStage("form");
    } catch {
      setError(
        "Could not reach the server. Your receipt is on this device — fill in the details and it will be sent when you're back online.",
      );
      setStage("form");
    }
  }

  async function save(saveAsApproved: boolean) {
    setSaving(true);
    setError(null);

    const payload: Record<string, unknown> = {
      type: values.type,
      date: values.date,
      amountInr: values.amountInr,
      originalCurrency: values.originalCurrency || null,
      originalAmount: values.originalAmount || null,
      categoryId: values.categoryId || null,
      vendorId: values.vendorId || null,
      projectId: values.projectId || null,
      paymentLabel: values.paymentLabel || null,
      paymentMethod: values.paymentMethod || null,
      notes: values.notes || null,
      routing: values.routing,
      grossAmount: values.grossAmount || null,
      grossCurrency: values.grossCurrency || null,
      vatAmount: values.vatAmount || null,
      vatCurrency: values.vatCurrency || null,
      taxAmount: values.taxAmount || null,
      receiptBlobKey: values.receiptBlobKey || null,
      receiptMime: values.receiptMime || null,
      aiExtracted,
      aiConfidence,
      aiRaw,
      saveAsApproved,
    };

    // Offline: queue it (with the image) and let the outbox drain later.
    if (!navigator.onLine) {
      try {
        await enqueue({
          payload,
          file: pendingFile ?? undefined,
          fileName: pendingFile?.name,
          fileType: pendingFile?.type,
        });
        setQueued(true);
      } catch {
        setError("Could not save to this device. Please try again.");
      } finally {
        setSaving(false);
      }
      return;
    }

    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not save this transaction.");
        return;
      }

      router.push(`/transactions?id=${data.id}`);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (queued) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm font-medium">Saved on this device</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-ink-muted">
          You&apos;re offline, so this transaction is queued. It will be sent
          automatically as soon as you&apos;re back online — you can close the app.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" onClick={reset}>
            Add another
          </Button>
        </div>
      </Card>
    );
  }

  if (stage === "reading") {
    return (
      <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
        <Spinner className="h-6 w-6 text-accent" />
        <p className="text-sm font-medium">Reading your receipt…</p>
        <p className="max-w-xs text-xs text-ink-muted">
          Pulling out the amount, date, vendor and category. You&apos;ll be able to
          correct anything before it saves.
        </p>
      </Card>
    );
  }

  if (stage === "choose") {
    return (
      <div className="space-y-4">
        <Card className="p-5 sm:p-6">
          <div className="mb-4 text-center">
            <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
              <IconSparkle className="h-5 w-5" />
            </span>
            <h2 className="text-sm font-semibold">Start with a receipt</h2>
            <p className="mx-auto mt-1 max-w-sm text-xs text-ink-muted">
              {aiConfigured
                ? "Snap or upload a receipt, invoice, salary slip or payment screenshot and we'll read the details for you. You can correct anything before saving."
                : "Attach a receipt for your records. AI reading isn't configured on this deployment, so you'll fill in the details yourself."}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={() => cameraRef.current?.click()}
            >
              <IconCamera className="h-4 w-4" />
              Take a photo
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => fileRef.current?.click()}
            >
              <IconUpload className="h-4 w-4" />
              Choose a file
            </Button>
          </div>

          {/* Direct camera capture on mobile (spec 13). */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />

          <p className="mt-3 text-center text-[11px] text-ink-muted">
            JPG, PNG, WebP or PDF · up to 10 MB
          </p>

          {error ? (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          ) : null}
        </Card>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-[11px] uppercase tracking-wide text-ink-muted">or</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={() => setStage("form")}
        >
          <IconFile className="h-4 w-4" />
          Enter details manually
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <Alert tone={aiExtracted ? "warning" : "info"}>{notice}</Alert>
      ) : null}

      {preview || values.receiptBlobKey ? (
        <Card className="flex items-center gap-3 p-3">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- blob: preview of a just-picked local file
            <img
              src={preview}
              alt="Receipt preview"
              className="h-16 w-16 rounded-lg border border-line object-cover"
            />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-muted">
              <IconFile className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Receipt attached</p>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Stored privately and linked to this transaction.
            </p>
          </div>
          <button
            type="button"
            aria-label="Remove receipt"
            onClick={() => {
              if (preview) URL.revokeObjectURL(preview);
              setPreview(null);
              setPendingFile(null);
              setValues((v) => ({ ...v, receiptBlobKey: "", receiptMime: "" }));
            }}
            className="rounded-lg p-2 text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
        </Card>
      ) : null}

      <TransactionForm
        values={values}
        onChange={setValues}
        refData={refData}
        canApprove={canApprove}
        vatEnabled={vatEnabled}
        approvalRequired={approvalRequired}
        fieldConfidence={fieldConfidence}
        aiExtracted={aiExtracted}
        error={error}
        saving={saving}
        onSubmit={save}
        secondaryAction={
          <Button
            type="button"
            variant="ghost"
            className={cx("sm:w-auto")}
            onClick={reset}
            disabled={saving}
          >
            Start over
          </Button>
        }
      />
    </div>
  );
}
