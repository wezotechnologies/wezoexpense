"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Select,
  Spinner,
  Textarea,
  cx,
} from "@/components/ui/primitives";
import { IconPlus, IconRepeat } from "@/components/icons";
import { formatDate, formatInr } from "@/lib/format";
import type { RecurringRuleDTO } from "@/lib/recurring";

/** Recurring rules (spec 7.4, 9.8) — rent, salaries, subscriptions. */

const FREQUENCY_LABEL = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
} as const;

export function RecurringManager({
  rules,
  categories,
  vendors,
  today,
}: {
  rules: RecurringRuleDTO[];
  categories: Array<{ id: string; name: string; type: "INCOME" | "EXPENSE" }>;
  vendors: Array<{ id: string; name: string }>;
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runReport, setRunReport] = useState<string | null>(null);
  // null = creating. A rule id = editing that rule with the same form, so
  // there is one set of fields and one set of validation rather than two.
  const [editingId, setEditingId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    type: "EXPENSE" as "INCOME" | "EXPENSE",
    frequency: "MONTHLY" as "WEEKLY" | "MONTHLY" | "YEARLY",
    nextRunDate: today,
    amountInr: "",
    categoryId: "",
    vendorId: "",
    notes: "",
    autoApprove: false,
  });

  const availableCategories = categories.filter((c) => c.type === form.type);

  const blank = {
    name: "",
    type: "EXPENSE" as "INCOME" | "EXPENSE",
    frequency: "MONTHLY" as "WEEKLY" | "MONTHLY" | "YEARLY",
    nextRunDate: today,
    amountInr: "",
    categoryId: "",
    vendorId: "",
    notes: "",
    autoApprove: false,
  };

  function startEdit(rule: RecurringRuleDTO) {
    setEditingId(rule.id);
    setError(null);
    setRunReport(null);
    setForm({
      name: rule.name,
      type: rule.type,
      frequency: rule.frequency,
      nextRunDate: rule.nextRunDate.slice(0, 10),
      amountInr: rule.amountInr,
      categoryId: rule.categoryId ?? "",
      vendorId: rule.vendorId ?? "",
      notes: rule.notes ?? "",
      autoApprove: rule.autoApprove,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
    setForm(blank);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(editingId ?? "new");
    setError(null);

    // Only the fields this form owns are sent. The route merges them into the
    // stored template, so anything it does not know about — a person's salary
    // working week, a payment label — survives the edit.
    const template = {
      amountInr: form.amountInr,
      categoryId: form.categoryId || null,
      vendorId: form.vendorId || null,
      notes: form.notes || null,
    };

    try {
      const response = await fetch("/api/recurring", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          editingId
            ? {
                id: editingId,
                name: form.name,
                type: form.type,
                frequency: form.frequency,
                nextRunDate: form.nextRunDate,
                autoApprove: form.autoApprove,
                template,
              }
            : {
                name: form.name,
                type: form.type,
                frequency: form.frequency,
                nextRunDate: form.nextRunDate,
                autoApprove: form.autoApprove,
                isActive: true,
                template: { ...template, routing: "DIRECT" },
              },
        ),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          data.error ??
            (editingId ? "Could not save that rule." : "Could not create that rule."),
        );
        return;
      }

      if (editingId) {
        setRunReport(`Saved ${form.name.trim() || "the rule"}.`);
        setEditingId(null);
        setForm(blank);
      } else {
        setForm({ ...form, name: "", amountInr: "", notes: "" });
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function toggle(rule: RecurringRuleDTO) {
    setBusy(rule.id);
    try {
      await fetch("/api/recurring", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: rule.id, isActive: !rule.isActive }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    setBusy("run");
    setError(null);
    setRunReport(null);
    try {
      const response = await fetch("/api/cron/recurring", { method: "POST" });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not run the rules.");
        return;
      }

      const report = data.report;
      setRunReport(
        report.created === 0
          ? "Nothing was due, so no transactions were created."
          : `Created ${report.created} transaction${report.created === 1 ? "" : "s"}.${
              report.skippedLockedMonths > 0
                ? ` Skipped ${report.skippedLockedMonths} occurrence(s) in closed months.`
                : ""
            }`,
      );
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
      <Card>
        <CardHeader
          title={editingId ? "Edit rule" : "New rule"}
          description={
            editingId
              ? "Correcting an amount here changes what future runs create; anything already generated is untouched."
              : "Rent, salaries, subscriptions."
          }
        />
        <form onSubmit={save} className="space-y-3 p-4">
          {error ? <Alert tone="error">{error}</Alert> : null}

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Name</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Office rent"
              required
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">Type</span>
              <Select
                value={form.type}
                onChange={(e) =>
                  setForm({
                    ...form,
                    type: e.target.value as "INCOME" | "EXPENSE",
                    categoryId: "",
                  })
                }
              >
                <option value="EXPENSE">Expense</option>
                <option value="INCOME">Income</option>
              </Select>
            </label>

            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Repeats
              </span>
              <Select
                value={form.frequency}
                onChange={(e) =>
                  setForm({
                    ...form,
                    frequency: e.target.value as typeof form.frequency,
                  })
                }
              >
                {Object.entries(FREQUENCY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Amount (INR)
              </span>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={form.amountInr}
                onChange={(e) => setForm({ ...form, amountInr: e.target.value })}
                className="tabular"
                required
              />
            </label>

            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                First run
              </span>
              <Input
                type="date"
                value={form.nextRunDate}
                onChange={(e) => setForm({ ...form, nextRunDate: e.target.value })}
                required
              />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Category
            </span>
            <Select
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            >
              <option value="">Uncategorised</option>
              {availableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              {form.type === "INCOME" ? "Client" : "Vendor"}
            </span>
            <Select
              value={form.vendorId}
              onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
            >
              <option value="">Not specified</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Notes</span>
            <Textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Appears on each generated transaction"
            />
          </label>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={form.autoApprove}
              onChange={(e) => setForm({ ...form, autoApprove: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-line bg-surface-2 accent-[var(--accent)]"
            />
            <span className="text-[11px] text-ink-muted">
              Approve automatically. Leave off to have each generated transaction
              go through the approval queue.
            </span>
          </label>

          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              disabled={busy !== null || !form.name || !form.amountInr}
            >
              {busy !== null ? (
                <Spinner />
              ) : editingId ? null : (
                <IconPlus className="h-4 w-4" />
              )}
              {editingId ? "Save changes" : "Create rule"}
            </Button>
            {editingId ? (
              <Button variant="secondary" onClick={cancelEdit} disabled={busy !== null}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Rules"
          description={`${rules.filter((r) => r.isActive).length} active of ${rules.length}`}
          action={
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === "run"}
              onClick={runNow}
            >
              {busy === "run" ? <Spinner /> : <IconRepeat className="h-3.5 w-3.5" />}
              Run due now
            </Button>
          }
        />

        {runReport ? (
          <div className="border-b border-line p-3">
            <Alert tone="success">{runReport}</Alert>
          </div>
        ) : null}

        {rules.length === 0 ? (
          <EmptyState
            icon={<IconRepeat className="h-7 w-7" />}
            title="No recurring rules yet"
            description="Set one up for anything that repeats — rent, salaries, a monthly subscription — and it will be created for you on schedule."
          />
        ) : (
          <ul className="divide-y divide-line">
            {rules.map((rule) => {
              const due = new Date(rule.nextRunDate) <= new Date();
              return (
                <li key={rule.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <p
                        className={cx(
                          "flex flex-wrap items-center gap-1.5 text-sm font-medium",
                          !rule.isActive && "text-ink-muted",
                        )}
                      >
                        <span className={cx(!rule.isActive && "line-through")}>
                          {rule.name}
                        </span>
                        <Badge tone={rule.type === "INCOME" ? "income" : "expense"}>
                          {rule.type === "INCOME" ? "Income" : "Expense"}
                        </Badge>
                        <Badge tone="neutral">{FREQUENCY_LABEL[rule.frequency]}</Badge>
                        {rule.autoApprove ? (
                          <Badge tone="approved">Auto-approve</Badge>
                        ) : null}
                        {rule.isActive && due ? (
                          <Badge tone="pending">Due</Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-muted">
                        <span className="tabular">{formatInr(rule.amountInr)}</span>
                        {rule.categoryName ? ` · ${rule.categoryName}` : ""}
                        {rule.vendorName ? ` · ${rule.vendorName}` : ""}
                        {" · next "}
                        {formatDate(rule.nextRunDate)}
                        {rule.generatedCount > 0
                          ? ` · ${rule.generatedCount} created so far`
                          : ""}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => startEdit(rule)}
                      >
                        {editingId === rule.id ? "Editing" : "Edit"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === rule.id}
                        onClick={() => toggle(rule)}
                      >
                        {rule.isActive ? "Pause" : "Resume"}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="border-t border-line px-4 py-2.5 text-[11px] text-ink-muted">
          A scheduler should call <code>POST /api/cron/recurring</code> daily with
          the shared secret. Missed periods are caught up on the next run, and
          occurrences dated in a closed month are skipped rather than reopening it.
        </p>
      </Card>
    </div>
  );
}
