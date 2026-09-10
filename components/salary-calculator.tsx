"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  Alert,
  Button,
  Card,
  CardHeader,
  Input,
  Select,
  cx,
} from "@/components/ui/primitives";
import { formatInr, formatMonthKey } from "@/lib/format";
import {
  DEFAULT_SALARY_BASIS,
  SALARY_BASES,
  type SalaryBasis,
  computePayout,
  describeBasis,
  paiseToRupees,
  parseRupeesToPaise,
  periodDaysFor,
  shortBasisLabel,
} from "@/lib/salary";

export type SalaryPreset = {
  id: string;
  name: string;
  monthlyInr: string;
  categoryId: string | null;
  categoryName: string | null;
  vendorId: string | null;
  /** null when this person's working week has never been recorded. */
  basis: SalaryBasis | null;
};

type Named = { id: string; name: string };

/**
 * Enter a monthly salary and the days paid; read off what to pay.
 *
 * The arithmetic is `lib/salary.ts`, the same module the recording route uses,
 * so what is shown here and what gets stored come from one implementation.
 *
 * Two deliberate choices in the interface:
 *
 *  - Days paid is pre-filled with the whole month, so the common case — a full
 *    month — needs no input beyond picking the person. You reduce it for
 *    unpaid leave rather than building it up from zero.
 *  - The working is shown, not just the answer. A salary figure someone cannot
 *    check is a figure they have to take on trust, and this one is going to be
 *    questioned by whoever receives it.
 */
export function SalaryCalculator({
  presets,
  categories,
  vendors,
  defaultMonth,
  today,
}: {
  presets: SalaryPreset[];
  categories: Named[];
  vendors: Named[];
  defaultMonth: string;
  today: string;
}) {
  const router = useRouter();

  const [presetId, setPresetId] = useState("");
  const [name, setName] = useState("");
  const [salary, setSalary] = useState("");
  const [month, setMonth] = useState(defaultMonth);
  const [basis, setBasis] = useState<SalaryBasis>(DEFAULT_SALARY_BASIS);
  // Mirrors what the server has stored, so the offer to remember a change
  // appears only when there is actually something to change.
  const [savedBasis, setSavedBasis] = useState<SalaryBasis | null>(null);
  const [savingBasis, setSavingBasis] = useState(false);
  const [daysPaid, setDaysPaid] = useState<string>("");
  const [categoryId, setCategoryId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [payDate, setPayDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [approveNow, setApproveNow] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const periodDays = useMemo(() => periodDaysFor(month, basis), [month, basis]);
  const monthlyPaise = useMemo(() => parseRupeesToPaise(salary), [salary]);

  // Blank means "the whole month", which keeps a full month zero-effort and
  // re-resolves correctly when the month or basis changes the day count.
  const effectiveDays = daysPaid === "" ? periodDays : Number(daysPaid);

  const payout = useMemo(() => {
    if (monthlyPaise === null || periodDays <= 0) return null;
    if (!Number.isFinite(effectiveDays)) return null;
    return computePayout({
      monthlyPaise,
      monthKey: month,
      basis,
      paidHalfDays: Math.round(effectiveDays * 2),
    });
  }, [monthlyPaise, month, basis, effectiveDays, periodDays]);

  const salaryInvalid = salary.trim() !== "" && monthlyPaise === null;
  const daysInvalid =
    daysPaid !== "" &&
    (!Number.isFinite(effectiveDays) ||
      effectiveDays < 0 ||
      effectiveDays > periodDays);

  function applyPreset(id: string) {
    setPresetId(id);
    setDone(null);
    setError(null);
    const preset = presets.find((p) => p.id === id);
    if (!preset) {
      setSavedBasis(null);
      return;
    }
    setName(preset.name);
    setSalary(preset.monthlyInr);
    setCategoryId(preset.categoryId ?? "");
    setVendorId(preset.vendorId ?? "");
    // Their contracted working week, so a Mon–Fri employee is never
    // accidentally paid on a Mon–Sat calculation.
    setBasis(preset.basis ?? DEFAULT_SALARY_BASIS);
    setSavedBasis(preset.basis);
  }

  /** Store the chosen working week against this person, for every future month. */
  async function rememberBasis() {
    if (!presetId) return;
    setSavingBasis(true);
    setError(null);
    try {
      const response = await fetch("/api/salary", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ruleId: presetId, basis }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? "Could not save the working week.");
        return;
      }
      setSavedBasis(basis);
      setDone(`${name.trim() || "This employee"} is now on ${shortBasisLabel(basis)}.`);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSavingBasis(false);
    }
  }

  async function record() {
    if (!payout || monthlyPaise === null) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch("/api/salary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // The amount is deliberately not sent — the server recomputes it.
          monthlyInr: salary,
          month,
          basis,
          paidHalfDays: Math.round(payout.paidDays * 2),
          employeeName: name.trim(),
          date: payDate,
          categoryId: categoryId || null,
          vendorId: vendorId || null,
          notes: notes.trim() || null,
          saveAsApproved: approveNow,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? "Could not record the payment.");
        return;
      }
      setDone(
        `Recorded ${formatInr(body.payable)} for ${name.trim()}${
          approveNow ? "" : " — it is waiting in Approvals"
        }.`,
      );
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const canRecord =
    !busy &&
    payout !== null &&
    payout.payablePaise > 0 &&
    name.trim() !== "" &&
    !salaryInvalid &&
    !daysInvalid;

  const basisHint = SALARY_BASES.find((b) => b.value === basis)?.hint ?? "";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Work it out"
          description="Pick someone or type the figures."
        />
        <div className="space-y-3 p-4">
          {presets.length > 0 ? (
            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Employee
              </span>
              <Select
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="">Type the details myself</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatInr(p.monthlyInr)}
                    {p.basis ? ` · ${shortBasisLabel(p.basis)}` : ""}
                  </option>
                ))}
              </Select>
              <span className="block text-[11px] text-ink-muted/70">
                Taken from your active recurring expenses, along with each
                person&rsquo;s working week once you have set it.
              </span>
            </label>
          ) : null}

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Paying
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pankaj"
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Monthly salary (INR)
            </span>
            <Input
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              inputMode="decimal"
              placeholder="33,500"
              aria-invalid={salaryInvalid || undefined}
            />
            {salaryInvalid ? (
              <span className="block text-[11px] text-danger">
                Enter a plain amount, e.g. 33500 or 33,500.00
              </span>
            ) : null}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Month
              </span>
              <Input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value || defaultMonth)}
              />
            </label>

            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Days paid
              </span>
              <Input
                value={daysPaid}
                onChange={(e) => setDaysPaid(e.target.value)}
                inputMode="decimal"
                type="number"
                min={0}
                max={periodDays || undefined}
                step={0.5}
                placeholder={periodDays > 0 ? String(periodDays) : ""}
                aria-invalid={daysInvalid || undefined}
              />
            </label>
          </div>

          <p className="text-[11px] text-ink-muted/70">
            {daysInvalid
              ? null
              : daysPaid === ""
                ? `Blank means the full month — all ${periodDays} days.`
                : "Half days are allowed, e.g. 23.5."}
          </p>
          {daysInvalid ? (
            <span className="block text-[11px] text-danger">
              Enter between 0 and {periodDays} days.
            </span>
          ) : null}

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Working week
            </span>
            <Select
              value={basis}
              onChange={(e) => setBasis(e.target.value as SalaryBasis)}
            >
              {SALARY_BASES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label} — {periodDaysFor(month, b.value)} days
                </option>
              ))}
            </Select>
            <span className="block text-[11px] text-ink-muted/70">
              {basisHint}
            </span>
          </label>

          {/* Staff differ — some Mon–Sat, some Mon–Fri — so the week is stored
              against the person rather than re-chosen every month. Offered only
              when it would actually change what is stored. */}
          {presetId && basis !== savedBasis ? (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
              <p className="text-[11px] text-ink-muted">
                {savedBasis === null
                  ? `${name.trim() || "This employee"} has no working week saved yet.`
                  : `${name.trim() || "This employee"} is saved as ${shortBasisLabel(savedBasis)}.`}
              </p>
              <Button
                variant="secondary"
                onClick={rememberBasis}
                disabled={savingBasis}
                className="mt-2 w-full"
              >
                {savingBasis
                  ? "Saving…"
                  : `Always use ${shortBasisLabel(basis)} for ${name.trim() || "this employee"}`}
              </Button>
            </div>
          ) : null}

          {presetId && savedBasis !== null && basis === savedBasis ? (
            <p className="text-[11px] text-ink-muted/70">
              Saved working week for {name.trim() || "this employee"} —
              applied automatically each month.
            </p>
          ) : null}
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <div className="space-y-4">
        <Card>
          <CardHeader title="Pay this" />
          <div className="p-4">
            {payout === null ? (
              <p className="text-sm text-ink-muted">
                Enter a monthly salary to see the figure.
              </p>
            ) : (
              <>
                <p className="text-3xl font-semibold tracking-tight tabular">
                  {formatInr(paiseToRupees(payout.payablePaise))}
                </p>
                <p className="mt-1 text-sm text-ink-muted">
                  {payout.paidDays} of {payout.periodDays}{" "}
                  {describeBasis(basis)} in {formatMonthKey(month)}
                </p>

                <dl className="mt-4 grid gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Full monthly salary</dt>
                    <dd className="tabular">
                      {formatInr(paiseToRupees(payout.payablePaise + payout.lopPaise))}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">A day&rsquo;s pay</dt>
                    <dd className="tabular">
                      {formatInr(paiseToRupees(payout.perDayPaise))}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Days not paid</dt>
                    <dd className="tabular">
                      {payout.periodDays - payout.paidDays}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Deducted</dt>
                    <dd
                      className={cx(
                        "tabular",
                        payout.lopPaise > 0 ? "text-danger" : undefined,
                      )}
                    >
                      {formatInr(paiseToRupees(payout.lopPaise))}
                    </dd>
                  </div>
                </dl>

                {/* The sum, spelled out. A part-month salary is the figure most
                    likely to be challenged by the person receiving it. */}
                <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] leading-relaxed text-ink-muted/80">
                  {formatInr(paiseToRupees(payout.payablePaise + payout.lopPaise))}{" "}
                  ÷ {payout.periodDays} × {payout.paidDays} ={" "}
                  {formatInr(paiseToRupees(payout.payablePaise))}
                </p>
                {payout.perDayPaise * payout.paidDays !== payout.payablePaise ? (
                  <p className="mt-1 text-[11px] text-ink-muted/60">
                    Worked from the monthly salary, not by multiplying the
                    rounded daily rate — that would give{" "}
                    {formatInr(paiseToRupees(Math.round(payout.perDayPaise * payout.paidDays)))}.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </Card>

        {/* -------------------------------------------------------------- */}
        <Card>
          <CardHeader
            title="Record it"
            description="Books the amount above as an expense, so you don't retype it."
          />
          <div className="space-y-3 p-4">
            {error ? <Alert tone="error">{error}</Alert> : null}
            {done ? <Alert tone="success">{done}</Alert> : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block space-y-1">
                <span className="block text-[11px] font-medium text-ink-muted">
                  Paid on
                </span>
                <Input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </label>

              <label className="block space-y-1">
                <span className="block text-[11px] font-medium text-ink-muted">
                  Category
                </span>
                <Select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">Uncategorised</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="block space-y-1">
                <span className="block text-[11px] font-medium text-ink-muted">
                  Vendor
                </span>
                <Select
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                >
                  <option value="">Not specified</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Extra note (optional)
              </span>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything else worth recording"
              />
              <span className="block text-[11px] text-ink-muted/70">
                The month, the day count and the basis are saved automatically,
                so the figure can be checked later.
              </span>
            </label>

            <label className="flex items-start gap-2 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={approveNow}
                onChange={(e) => setApproveNow(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-line"
              />
              <span>
                Approve immediately. Leave off to send it through the approval
                queue like any other expense.
              </span>
            </label>

            <Button onClick={record} disabled={!canRecord} className="w-full">
              {busy
                ? "Recording…"
                : payout && payout.payablePaise > 0
                  ? `Record ${formatInr(paiseToRupees(payout.payablePaise))} as an expense`
                  : "Record as an expense"}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
