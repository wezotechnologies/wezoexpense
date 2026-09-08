"use client";

import { useRouter, useSearchParams } from "next/navigation";
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
  cx,
} from "@/components/ui/primitives";
import { IconPlus, IconTag } from "@/components/icons";

/** Categories, vendors/clients and projects (spec 9.10, 11). Admin+ only. */

type Category = {
  id: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  isActive: boolean;
  isSystem: boolean;
};
type Vendor = {
  id: string;
  name: string;
  kind: "CLIENT" | "VENDOR";
  notes: string | null;
  isActive: boolean;
  transactionCount: number;
};
type Project = {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  isActive: boolean;
};

type Tab = "categories" | "vendors" | "projects";

export function DirectoriesManager({
  categories,
  vendors,
  projects,
}: {
  categories: Category[];
  vendors: Vendor[];
  projects: Project[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get("tab") as Tab) ?? "categories";

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: "categories", label: "Categories", count: categories.length },
    { id: "vendors", label: "Vendors & clients", count: vendors.length },
    { id: "projects", label: "Projects", count: projects.length },
  ];

  return (
    <>
      <div
        className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-line bg-surface p-1"
        role="tablist"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => router.push(`/directories?tab=${t.id}`)}
            className={cx(
              "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              tab === t.id
                ? "bg-accent-soft text-accent"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {t.label}
            <span className="ml-1.5 text-[10px] opacity-70">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === "categories" ? <CategoriesPanel items={categories} /> : null}
      {tab === "vendors" ? <VendorsPanel items={vendors} /> : null}
      {tab === "projects" ? (
        <ProjectsPanel items={projects} clients={vendors} />
      ) : null}
    </>
  );
}

/** Shared request helper: posts, refreshes, and surfaces the server's message. */
function useDirectoryAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(
    url: string,
    method: "POST" | "PATCH",
    body: unknown,
    onDone?: () => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "That could not be saved.");
        return false;
      }
      onDone?.();
      router.refresh();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, send };
}

function CategoriesPanel({ items }: { items: Category[] }) {
  const { busy, error, send } = useDirectoryAction();
  const [name, setName] = useState("");
  const [type, setType] = useState<"INCOME" | "EXPENSE">("EXPENSE");

  const income = items.filter((c) => c.type === "INCOME");
  const expense = items.filter((c) => c.type === "EXPENSE");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_1fr]">
      <Card>
        <CardHeader title="Add a category" />
        <form
          className="space-y-3 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await send("/api/categories", "POST", { name, type }, () => setName(""));
          }}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cloud hosting"
              required
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Side</span>
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as "INCOME" | "EXPENSE")}
            >
              <option value="EXPENSE">Expense</option>
              <option value="INCOME">Income</option>
            </Select>
          </label>
          <Button type="submit" variant="primary" className="w-full" disabled={busy || !name}>
            {busy ? <Spinner /> : <IconPlus className="h-4 w-4" />}
            Add category
          </Button>
          <p className="text-[11px] text-ink-muted">
            A category belongs to one side of the books, so income and expense
            lists never mix.
          </p>
        </form>
      </Card>

      <div className="space-y-4">
        <CategoryList title="Income categories" items={income} send={send} busy={busy} />
        <CategoryList title="Expense categories" items={expense} send={send} busy={busy} />
      </div>
    </div>
  );
}

function CategoryList({
  title,
  items,
  send,
  busy,
}: {
  title: string;
  items: Category[];
  send: ReturnType<typeof useDirectoryAction>["send"];
  busy: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} description={`${items.length} in this list`} />
      {items.length === 0 ? (
        <EmptyState title="Nothing here yet" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <span
                className={cx(
                  "min-w-0 flex-1 truncate text-sm",
                  !c.isActive && "text-ink-muted line-through",
                )}
              >
                {c.name}
              </span>
              {c.isSystem ? <Badge tone="neutral">Default</Badge> : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  send("/api/categories", "PATCH", { id: c.id, isActive: !c.isActive })
                }
              >
                {c.isActive ? "Deactivate" : "Reactivate"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function VendorsPanel({ items }: { items: Vendor[] }) {
  const { busy, error, send } = useDirectoryAction();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"CLIENT" | "VENDOR">("VENDOR");
  const [notes, setNotes] = useState("");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_1fr]">
      <Card>
        <CardHeader title="Add a vendor or client" />
        <form
          className="space-y-3 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await send("/api/vendors", "POST", { name, kind, notes: notes || null }, () => {
              setName("");
              setNotes("");
            });
          }}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Pvt Ltd"
              required
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Kind</span>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as "CLIENT" | "VENDOR")}
            >
              <option value="VENDOR">Vendor / payee</option>
              <option value="CLIENT">Client (pays us)</option>
            </Select>
          </label>
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Notes (optional)
            </span>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth remembering"
            />
          </label>
          <Button type="submit" variant="primary" className="w-full" disabled={busy || !name}>
            {busy ? <Spinner /> : <IconPlus className="h-4 w-4" />}
            Add
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Directory" description={`${items.length} entries`} />
        {items.length === 0 ? (
          <EmptyState
            icon={<IconTag className="h-7 w-7" />}
            title="No vendors or clients yet"
            description="Add the people and companies you pay or get paid by, so transactions can be attributed."
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((v) => (
              <li key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p
                    className={cx(
                      "truncate text-sm font-medium",
                      !v.isActive && "text-ink-muted line-through",
                    )}
                  >
                    {v.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    {v.transactionCount} transaction
                    {v.transactionCount === 1 ? "" : "s"}
                    {v.notes ? ` · ${v.notes}` : ""}
                  </p>
                </div>
                <Badge tone={v.kind === "CLIENT" ? "accent" : "neutral"}>
                  {v.kind === "CLIENT" ? "Client" : "Vendor"}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    send("/api/vendors", "PATCH", { id: v.id, isActive: !v.isActive })
                  }
                >
                  {v.isActive ? "Deactivate" : "Reactivate"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ProjectsPanel({
  items,
  clients,
}: {
  items: Project[];
  clients: Vendor[];
}) {
  const { busy, error, send } = useDirectoryAction();
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_1fr]">
      <Card>
        <CardHeader title="Add a project" />
        <form
          className="space-y-3 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await send(
              "/api/projects",
              "POST",
              { name, clientId: clientId || null },
              () => {
                setName("");
                setClientId("");
              },
            );
          }}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme mobile app"
              required
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Client (optional)
            </span>
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Not linked</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="primary" className="w-full" disabled={busy || !name}>
            {busy ? <Spinner /> : <IconPlus className="h-4 w-4" />}
            Add project
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Projects" description={`${items.length} projects`} />
        {items.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="Projects are optional — use them to group income under a piece of client work."
          />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p
                    className={cx(
                      "truncate text-sm font-medium",
                      !p.isActive && "text-ink-muted line-through",
                    )}
                  >
                    {p.name}
                  </p>
                  {p.clientName ? (
                    <p className="mt-0.5 text-[11px] text-ink-muted">{p.clientName}</p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    send("/api/projects", "PATCH", { id: p.id, isActive: !p.isActive })
                  }
                >
                  {p.isActive ? "Deactivate" : "Reactivate"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
