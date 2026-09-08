"use client";

import { useMemo, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { IconArrowDown, IconArrowUp, IconSparkle } from "@/components/icons";
import { formatInr } from "@/lib/format";
import { CURRENCIES_UI, PAYMENT_LABELS_UI, PAYMENT_METHODS_UI } from "@/lib/ui-constants";

/**
 * The one transaction form, used by Add and Edit (spec 7.1, 7.2).
 *
 * Every AI-suggested value is an ordinary editable control — nothing is
 * read-only because AI filled it (spec 19). Fields the model was unsure about
 * get a "check this" marker, which is a hint, not a lock.
 *
 * The form is fully usable with no AI and no receipt: that is the fallback path
 * the spec requires to always work.
 */

export type FieldConfidence = {
  amount: number;
  date: number;
  vendor: number;
  category: number;
};

export type TransactionFormValues = {
  type: "INCOME" | "EXPENSE";
  date: string;
  amountInr: string;
  originalCurrency: string;
  originalAmount: string;
  categoryId: string;
  vendorId: string;
  projectId: string;
  paymentLabel: string;
  paymentMethod: string;
  notes: string;
  routing: "DIRECT" | "VIA_DUBAI_PARTNER";
  grossAmount: string;
  grossCurrency: string;
  vatAmount: string;
  vatCurrency: string;
  taxAmount: string;
  receiptBlobKey: string;
  receiptMime: string;
};

export type RefData = {
  categories: Array<{ id: string; name: string; type: "INCOME" | "EXPENSE" }>;
  vendors: Array<{ id: string; name: string; kind: "CLIENT" | "VENDOR" }>;
  projects: Array<{ id: string; name: string; clientId: string | null }>;
};

export function emptyFormValues(today: string): TransactionFormValues {
  return {
    type: "EXPENSE",
    date: today,
    amountInr: "",
    originalCurrency: "",
    originalAmount: "",
    categoryId: "",
    vendorId: "",
    projectId: "",
    paymentLabel: "",
    paymentMethod: "",
    notes: "",
    routing: "DIRECT",
    grossAmount: "",
    grossCurrency: "",
    vatAmount: "",
    vatCurrency: "",
    taxAmount: "",
    receiptBlobKey: "",
    receiptMime: "",
  };
}

/** Threshold below which a field is flagged for a second look (spec 8.3). */
const VERIFY_BELOW = 0.75;

export function TransactionForm({
  values,
  onChange,
  refData,
  canApprove,
  vatEnabled,
  approvalRequired,
  fieldConfidence,
  aiExtracted,
  error,
  saving,
  onSubmit,
  submitLabel = "Save transaction",
  secondaryAction,
  showApproveToggle = true,
}: {
  values: TransactionFormValues;
  onChange: (next: TransactionFormValues) => void;
  refData: RefData;
  canApprove: boolean;
  vatEnabled: boolean;
  approvalRequired: boolean;
  fieldConfidence?: FieldConfidence | null;
  aiExtracted?: boolean;
  error?: string | null;
  saving?: boolean;
  onSubmit: (saveAsApproved: boolean) => void;
  submitLabel?: string;
  secondaryAction?: React.ReactNode;
  showApproveToggle?: boolean;
}) {
  const [showForeign, setShowForeign] = useState(
    !!values.originalAmount || !!values.originalCurrency,
  );

  const set = <K extends keyof TransactionFormValues>(
    key: K,
    value: TransactionFormValues[K],
  ) => onChange({ ...values, [key]: value });

  const isIncome = values.type === "INCOME";

  const categories = useMemo(
    () => refData.categories.filter((c) => c.type === values.type),
    [refData.categories, values.type],
  );

  const vendors = useMemo(
    () =>
      [...refData.vendors].sort((a, b) => {
        // Clients first on income, vendors first on expense.
        const preferred = isIncome ? "CLIENT" : "VENDOR";
        if (a.kind === b.kind) return a.name.localeCompare(b.name);
        return a.kind === preferred ? -1 : 1;
      }),
    [refData.vendors, isIncome],
  );

  const uncertain = (key: keyof FieldConfidence) =>
    !!fieldConfidence && fieldConfidence[key] < VERIFY_BELOW && aiExtracted;

  const verifyHint = "AI wasn't sure — please check this.";

  function switchType(next: "INCOME" | "EXPENSE") {
    onChange({
      ...values,
      type: next,
      // A category belongs to one side of the books, so it can't survive a flip.
      categoryId: "",
      // VAT routing and tax are side-specific too.
      routing: next === "INCOME" ? values.routing : "DIRECT",
      grossAmount: next === "INCOME" ? values.grossAmount : "",
      grossCurrency: next === "INCOME" ? values.grossCurrency : "",
      vatAmount: next === "INCOME" ? values.vatAmount : "",
      vatCurrency: next === "INCOME" ? values.vatCurrency : "",
      taxAmount: next === "EXPENSE" ? values.taxAmount : "",
    });
  }

  const derivedFx =
    values.amountInr && values.originalAmount && Number(values.originalAmount) > 0
      ? (Number(values.amountInr) / Number(values.originalAmount)).toFixed(4)
      : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(false);
      }}
    >
      {error ? <Alert tone="error">{error}</Alert> : null}

      {/* ---- Type ------------------------------------------------------ */}
      <Card className="p-4 sm:p-5">
        <Label className="mb-2">Type</Label>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Transaction type">
          <TypeButton
            active={isIncome}
            onClick={() => switchType("INCOME")}
            tone="income"
            icon={<IconArrowDown className="h-4 w-4" />}
            label="Income"
            hint="Money in"
          />
          <TypeButton
            active={!isIncome}
            onClick={() => switchType("EXPENSE")}
            tone="expense"
            icon={<IconArrowUp className="h-4 w-4" />}
            label="Expense"
            hint="Money out"
          />
        </div>
      </Card>

      {/* ---- Amount & date --------------------------------------------- */}
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Amount received in INR"
            htmlFor="amountInr"
            required
            hint={
              isIncome
                ? "The rupees that actually landed in the bank account."
                : "The rupees actually paid."
            }
            error={uncertain("amount") ? verifyHint : undefined}
          >
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">
                ₹
              </span>
              <Input
                id="amountInr"
                inputMode="decimal"
                placeholder="0.00"
                value={values.amountInr}
                onChange={(e) => set("amountInr", e.target.value)}
                className={cx("pl-7 tabular", uncertain("amount") && "border-pending")}
                required
              />
            </div>
          </Field>

          <Field
            label="Date money moved"
            htmlFor="date"
            required
            error={uncertain("date") ? verifyHint : undefined}
          >
            <Input
              id="date"
              type="date"
              value={values.date}
              onChange={(e) => set("date", e.target.value)}
              className={cx(uncertain("date") && "border-pending")}
              required
            />
          </Field>
        </div>

        {/* Foreign currency (spec 5.2, 5.5) */}
        {!showForeign ? (
          <button
            type="button"
            onClick={() => setShowForeign(true)}
            className="text-xs text-accent hover:underline"
          >
            + Paid in another currency?
          </button>
        ) : (
          <div className="rounded-lg border border-line bg-surface-2/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium">Original currency (for reference)</p>
              <button
                type="button"
                onClick={() => {
                  setShowForeign(false);
                  onChange({ ...values, originalAmount: "", originalCurrency: "" });
                }}
                className="text-[11px] text-ink-muted hover:text-ink"
              >
                Remove
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Original amount" htmlFor="originalAmount">
                <Input
                  id="originalAmount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={values.originalAmount}
                  onChange={(e) => set("originalAmount", e.target.value)}
                  className="tabular"
                />
              </Field>
              <Field label="Currency" htmlFor="originalCurrency">
                <Select
                  id="originalCurrency"
                  value={values.originalCurrency}
                  onChange={(e) => set("originalCurrency", e.target.value)}
                >
                  <option value="">Select…</option>
                  {CURRENCIES_UI.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <p className="mt-2 text-[11px] text-ink-muted">
              {derivedFx
                ? `Exchange rate ${derivedFx} — worked out from the two amounts and stored with the record.`
                : "Only the INR figure is booked. The original amount is kept for reference."}
            </p>
          </div>
        )}
      </Card>

      {/* ---- Classification -------------------------------------------- */}
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Category"
            htmlFor="categoryId"
            error={uncertain("category") ? verifyHint : undefined}
          >
            <Select
              id="categoryId"
              value={values.categoryId}
              onChange={(e) => set("categoryId", e.target.value)}
              className={cx(uncertain("category") && "border-pending")}
            >
              <option value="">Uncategorised</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={isIncome ? "Client" : "Vendor / payee"}
            htmlFor="vendorId"
            error={uncertain("vendor") ? verifyHint : undefined}
          >
            <Select
              id="vendorId"
              value={values.vendorId}
              onChange={(e) => set("vendorId", e.target.value)}
              className={cx(uncertain("vendor") && "border-pending")}
            >
              <option value="">Not specified</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.kind === "CLIENT" ? " (client)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment method" htmlFor="paymentMethod">
            <Select
              id="paymentMethod"
              value={values.paymentMethod}
              onChange={(e) => set("paymentMethod", e.target.value)}
            >
              <option value="">Not specified</option>
              {PAYMENT_METHODS_UI.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>

          {isIncome ? (
            <Field
              label="Payment label"
              htmlFor="paymentLabel"
              hint="Which instalment is this? Pick one or type your own."
            >
              <Input
                id="paymentLabel"
                list="payment-labels"
                placeholder="e.g. 1st payment"
                value={values.paymentLabel}
                onChange={(e) => set("paymentLabel", e.target.value)}
              />
              <datalist id="payment-labels">
                {PAYMENT_LABELS_UI.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Field>
          ) : (
            <Field
              label="Tax / VAT included"
              htmlFor="taxAmount"
              hint="Optional, for reference only."
            >
              <Input
                id="taxAmount"
                inputMode="decimal"
                placeholder="0.00"
                value={values.taxAmount}
                onChange={(e) => set("taxAmount", e.target.value)}
                className="tabular"
              />
            </Field>
          )}
        </div>

        {isIncome && refData.projects.length > 0 ? (
          <Field label="Project" htmlFor="projectId">
            <Select
              id="projectId"
              value={values.projectId}
              onChange={(e) => set("projectId", e.target.value)}
            >
              <option value="">Not specified</option>
              {refData.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </Card>

      {/* ---- VAT via Dubai partner (spec 5.4) --------------------------- */}
      {isIncome && vatEnabled ? (
        <Card className="p-4 sm:p-5">
          <Label className="mb-2">How was this collected?</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <RoutingButton
              active={values.routing === "DIRECT"}
              onClick={() => onChange({ ...values, routing: "DIRECT", grossAmount: "", grossCurrency: "", vatAmount: "", vatCurrency: "" })}
              label="Paid to Wezo India"
              hint="Client paid us directly"
            />
            <RoutingButton
              active={values.routing === "VIA_DUBAI_PARTNER"}
              onClick={() => set("routing", "VIA_DUBAI_PARTNER")}
              label="Via Dubai partner"
              hint="Partner collected and handled VAT"
            />
          </div>

          {values.routing === "VIA_DUBAI_PARTNER" ? (
            <div className="mt-3 space-y-3">
              <Alert tone="info">
                VAT is handled by the Dubai partner and is <strong>not</strong> counted
                as Wezo income. Only the net amount that reached India — the INR figure
                above — is booked. The gross and VAT below are kept for reference and
                appear as a memo line on reports.
              </Alert>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Gross the client paid" htmlFor="grossAmount">
                  <Input
                    id="grossAmount"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={values.grossAmount}
                    onChange={(e) => set("grossAmount", e.target.value)}
                    className="tabular"
                  />
                </Field>
                <Field label="Gross currency" htmlFor="grossCurrency">
                  <Select
                    id="grossCurrency"
                    value={values.grossCurrency}
                    onChange={(e) => set("grossCurrency", e.target.value)}
                  >
                    <option value="">Select…</option>
                    {CURRENCIES_UI.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="VAT the partner handled" htmlFor="vatAmount">
                  <Input
                    id="vatAmount"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={values.vatAmount}
                    onChange={(e) => set("vatAmount", e.target.value)}
                    className="tabular"
                  />
                </Field>
                <Field label="VAT currency" htmlFor="vatCurrency">
                  <Select
                    id="vatCurrency"
                    value={values.vatCurrency}
                    onChange={(e) => set("vatCurrency", e.target.value)}
                  >
                    <option value="">Select…</option>
                    {CURRENCIES_UI.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ---- Notes ------------------------------------------------------ */}
      <Card className="p-4 sm:p-5">
        <Field label="Notes" htmlFor="notes">
          <Textarea
            id="notes"
            rows={3}
            placeholder="Anything worth remembering about this transaction…"
            value={values.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </Card>

      {/* ---- Save ------------------------------------------------------- */}
      <div className="sticky bottom-20 z-10 rounded-lg border border-line bg-surface/95 p-3 backdrop-blur lg:bottom-4">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-ink-muted">
            {values.amountInr ? (
              <>
                Booking{" "}
                <strong className={isIncome ? "text-income" : "text-expense"}>
                  {formatInr(values.amountInr)}
                </strong>{" "}
                as {isIncome ? "income" : "an expense"}
              </>
            ) : (
              "Enter an amount to continue"
            )}
          </span>
          {aiExtracted ? (
            <span className="inline-flex items-center gap-1 text-accent">
              <IconSparkle className="h-3.5 w-3.5" />
              AI-assisted
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          {secondaryAction}
          {canApprove && showApproveToggle ? (
            <>
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                disabled={saving}
                onClick={() => onSubmit(false)}
              >
                {saving ? <Spinner /> : null}
                Save as pending
              </Button>
              <Button
                type="button"
                variant="primary"
                className="flex-1"
                disabled={saving}
                onClick={() => onSubmit(true)}
              >
                {saving ? <Spinner /> : null}
                Save &amp; approve
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              disabled={saving}
            >
              {saving ? <Spinner /> : null}
              {submitLabel}
            </Button>
          )}
        </div>

        {!canApprove && approvalRequired ? (
          <p className="mt-2 text-center text-[11px] text-ink-muted">
            This will be sent to an admin for approval.
          </p>
        ) : null}
      </div>
    </form>
  );
}

function TypeButton({
  active,
  onClick,
  tone,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  tone: "income" | "expense";
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cx(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
        active
          ? tone === "income"
            ? "border-income/50 bg-income/10"
            : "border-expense/50 bg-expense/10"
          : "border-line bg-surface-2 hover:border-ink-muted/40",
      )}
    >
      <span
        className={cx(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          active
            ? tone === "income"
              ? "bg-income/20 text-income"
              : "bg-expense/20 text-expense"
            : "bg-surface text-ink-muted",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] text-ink-muted">{hint}</span>
      </span>
    </button>
  );
}

function RoutingButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "rounded-lg border px-3 py-2.5 text-left transition-colors",
        active
          ? "border-accent/50 bg-accent-soft"
          : "border-line bg-surface-2 hover:border-ink-muted/40",
      )}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="block text-[11px] text-ink-muted">{hint}</span>
    </button>
  );
}
