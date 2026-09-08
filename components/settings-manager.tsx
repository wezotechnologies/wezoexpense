"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Select,
  Spinner,
} from "@/components/ui/primitives";
import { formatMonthKey } from "@/lib/format";

/** App settings (spec 9.12) — Superadmin only. */

type Settings = {
  baseCurrency: string;
  aiModel: string;
  aiMonthlySpendCapUsd: number;
  approvalRequired: boolean;
  vatEnabled: boolean;
};

type Meta = {
  ai: {
    configured: boolean;
    /** Providers with a key on this deployment. */
    providers: Array<"anthropic" | "openai">;
    /** The provider the currently-saved model belongs to. */
    activeProvider: "anthropic" | "openai";
    spentUsd: number;
    remainingUsd: number;
    month: string;
    exhausted: boolean;
  };
  storage: { mode: "azure" | "local"; configured: boolean };
  cronConfigured: boolean;
};

/** Vision-capable models worth offering. */
const MODELS = [
  // Cheapest first. These costs are MEASURED, not derived from per-token
  // pricing — for images the two diverge sharply. gpt-4o-mini spends 25,527
  // input tokens on a 620x880 receipt where gpt-4.1-mini spends 933, so it
  // ends up ~5x dearer per receipt despite a lower headline token price.
  // All three of the cheap options scored 7/7 fields on a real Indian GST
  // receipt, so accuracy is not what you trade away here.
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini — cheapest, recommended (~₹0.07, ≈25,000 receipts per $20)", provider: "openai" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest Claude (~₹0.23, ≈7,700 per $20)", provider: "anthropic" },
  { id: "gpt-4o-mini", label: "GPT-4o mini (~₹0.35, ≈5,000 per $20 — image tokens are costly)", provider: "openai" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (~₹0.69, ≈2,500 per $20)", provider: "anthropic" },
  { id: "gpt-4o", label: "GPT-4o (~₹0.83, ≈2,100 per $20)", provider: "openai" },
  { id: "claude-opus-5", label: "Claude Opus 5 — most capable (~₹1.40, ≈1,250 per $20)", provider: "anthropic" },
] as const;

export function SettingsManager({
  initial,
  meta,
}: {
  initial: Settings;
  meta: Meta;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Settings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          aiMonthlySpendCapUsd: Number(values.aiMonthlySpendCapUsd),
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not save these settings.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form onSubmit={save} className="space-y-4">
        <Card>
          <CardHeader title="Books" />
          <div className="space-y-4 p-4">
            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Reporting currency
              </span>
              <Input value={values.baseCurrency} disabled className="tabular" />
              <span className="block text-[11px] text-ink-muted">
                Wezo keeps one set of books in INR. Foreign amounts are recorded
                for reference against the rupees actually banked.
              </span>
            </label>

            <Toggle
              label="Require approval for submissions"
              hint="When on, an Employee's transaction starts as pending until an admin approves it. Admins can always save straight to approved."
              checked={values.approvalRequired}
              onChange={(v) => setValues({ ...values, approvalRequired: v })}
            />

            <Toggle
              label="VAT via Dubai partner"
              hint="Shows the Dubai-partner routing option on income. The partner's VAT is never counted as Wezo revenue — it appears as a memo on reports."
              checked={values.vatEnabled}
              onChange={(v) => setValues({ ...values, vatEnabled: v })}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="AI receipt reading" />
          <div className="space-y-4 p-4">
            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Model
              </span>
              <Select
                value={values.aiModel}
                onChange={(e) => setValues({ ...values, aiModel: e.target.value })}
              >
                {/* Only models whose provider has a key, grouped by vendor so
                    the choice of vendor is visible rather than implied. */}
                {(["openai", "anthropic"] as const)
                  .filter((p) => meta.ai.providers.includes(p))
                  .map((p) => (
                    <optgroup
                      key={p}
                      label={p === "openai" ? "OpenAI" : "Anthropic (Claude)"}
                    >
                      {MODELS.filter((m) => m.provider === p).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                {!MODELS.some((m) => m.id === values.aiModel) ? (
                  <option value={values.aiModel}>{values.aiModel}</option>
                ) : null}
              </Select>
              <span className="block text-[11px] text-ink-muted">
                {meta.ai.providers.length === 2
                  ? "Both providers are configured. The model you pick decides which one is used — no environment change needed."
                  : meta.ai.providers.length === 1
                    ? `Only ${meta.ai.providers[0] === "anthropic" ? "an Anthropic" : "an OpenAI"} key is configured, so only its models are listed. Add the other key and its models appear here too.`
                    : "No key is configured, so receipt reading is skipped and the manual form is used."}
              </span>
            </label>

            <label className="block space-y-1">
              <span className="block text-[11px] font-medium text-ink-muted">
                Monthly spend cap (USD)
              </span>
              <Input
                type="number"
                min={0}
                step="0.5"
                value={values.aiMonthlySpendCapUsd}
                onChange={(e) =>
                  setValues({
                    ...values,
                    aiMonthlySpendCapUsd: Number(e.target.value),
                  })
                }
                className="tabular"
              />
              <span className="block text-[11px] text-ink-muted">
                Once the estimate reaches this, receipt reading is skipped and the
                manual form is used instead. Nothing breaks — it just stops
                spending.
              </span>
            </label>
          </div>
        </Card>

        {error ? <Alert tone="error">{error}</Alert> : null}
        {saved && !dirty ? <Alert tone="success">Settings saved.</Alert> : null}

        <Button type="submit" variant="primary" size="lg" disabled={busy || !dirty}>
          {busy ? <Spinner /> : null}
          Save settings
        </Button>
      </form>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="This deployment"
            description="Read-only — these come from server environment variables."
          />
          <dl className="divide-y divide-line text-sm">
            <StatusRow
              label="AI receipt reading"
              ok={meta.ai.configured}
              okText={
                meta.ai.providers.length === 2
                  ? `Both — using ${meta.ai.activeProvider === "anthropic" ? "Anthropic" : "OpenAI"}`
                  : meta.ai.activeProvider === "anthropic"
                    ? "Anthropic (Claude)"
                    : "OpenAI"
              }
              badText="No API key set"
              hint={
                meta.ai.configured
                  ? `About $${meta.ai.spentUsd.toFixed(2)} used of $${initial.aiMonthlySpendCapUsd.toFixed(2)} in ${formatMonthKey(meta.ai.month)}.`
                  : "Uploads still work; the form is filled in by hand."
              }
            />
            <StatusRow
              label="Receipt storage"
              ok={meta.storage.configured}
              okText="Azure Blob (private)"
              badText="Local disk (development)"
              hint={
                meta.storage.configured
                  ? "Receipts are served through short-lived signed URLs."
                  : "Set AZURE_STORAGE_CONNECTION_STRING to store receipts in Azure."
              }
            />
            <StatusRow
              label="Recurring scheduler"
              ok={meta.cronConfigured}
              okText="Secret configured"
              badText="No CRON_SECRET set"
              hint="Point a scheduler at POST /api/cron/recurring with a bearer token. Admins can also run it by hand."
            />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Where secrets live" />
          <div className="space-y-2 p-4 text-xs text-ink-muted">
            <p>
              The OpenAI key, the Azure connection string, the database URL and
              the auth secret are read only on the server. They are never sent to
              the browser and are not part of the installable app.
            </p>
            <p>
              Receipts sit in a private container. When someone opens one, the
              server checks they are allowed to see that transaction and only then
              mints a signed link that expires in ten minutes.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-surface-2 border border-line"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full transition-transform ${
            checked
              ? "left-0.5 translate-x-4 bg-accent-contrast"
              : "left-0.5 bg-ink-muted"
          }`}
        />
      </button>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-[11px] text-ink-muted">{hint}</p>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  ok,
  okText,
  badText,
  hint,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
  hint: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-xs text-ink-muted">{label}</dt>
        <dd>
          <Badge tone={ok ? "approved" : "pending"}>{ok ? okText : badText}</Badge>
        </dd>
      </div>
      <p className="mt-1 text-[11px] text-ink-muted/80">{hint}</p>
    </div>
  );
}
