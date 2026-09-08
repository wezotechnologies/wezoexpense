"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button, Input, Select, cx } from "@/components/ui/primitives";
import { IconFilter, IconSearch, IconX } from "@/components/icons";
import { CURRENCIES_UI, STATUS_OPTIONS, TYPE_OPTIONS } from "@/lib/ui-constants";

/**
 * Filter bar for the transactions table (spec 9.4).
 * State lives in the URL so a filtered view is shareable, survives a refresh,
 * and is exactly what the CSV export reads.
 */

export type FilterOptions = {
  categories: Array<{ id: string; name: string; type: string }>;
  vendors: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string }>;
  canSeeAllUsers: boolean;
};

const FILTER_KEYS = [
  "q", "type", "status", "categoryId", "vendorId", "createdById",
  "currency", "routing", "from", "to",
] as const;

export function TxnFilters({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(params.get("q") ?? "");

  const activeCount = FILTER_KEYS.filter(
    (k) => k !== "q" && params.get(k),
  ).length;

  function apply(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page"); // a changed filter invalidates the page number
    next.delete("id"); // and closes any open row
    router.push(`/transactions?${next.toString()}`);
  }

  function clearAll() {
    const next = new URLSearchParams();
    router.push(`/transactions${next.toString() ? `?${next}` : ""}`);
    setSearch("");
  }

  const value = (key: string) => params.get(key) ?? "";

  return (
    <div className="mb-4 space-y-3">
      <div className="flex gap-2">
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            apply("q", search.trim());
          }}
        >
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendor, note, label or amount…"
            className="pl-8"
            aria-label="Search transactions"
          />
        </form>

        <Button
          type="button"
          variant={activeCount > 0 ? "primary" : "secondary"}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <IconFilter className="h-4 w-4" />
          Filters
          {activeCount > 0 ? (
            <span className="ml-0.5 rounded bg-accent-contrast/20 px-1 text-[11px] tabular">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </div>

      {open ? (
        <div className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label="Type">
            <Select value={value("type")} onChange={(e) => apply("type", e.target.value)}>
              <option value="">All</option>
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Labelled>

          <Labelled label="Status">
            <Select value={value("status")} onChange={(e) => apply("status", e.target.value)}>
              <option value="">All</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Labelled>

          <Labelled label="Category">
            <Select
              value={value("categoryId")}
              onChange={(e) => apply("categoryId", e.target.value)}
            >
              <option value="">All</option>
              {options.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type === "INCOME" ? "in" : "out"})
                </option>
              ))}
            </Select>
          </Labelled>

          <Labelled label="Vendor / client">
            <Select
              value={value("vendorId")}
              onChange={(e) => apply("vendorId", e.target.value)}
            >
              <option value="">All</option>
              {options.vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </Select>
          </Labelled>

          <Labelled label="From">
            <Input type="date" value={value("from")} onChange={(e) => apply("from", e.target.value)} />
          </Labelled>

          <Labelled label="To">
            <Input type="date" value={value("to")} onChange={(e) => apply("to", e.target.value)} />
          </Labelled>

          <Labelled label="Currency">
            <Select value={value("currency")} onChange={(e) => apply("currency", e.target.value)}>
              <option value="">All</option>
              {CURRENCIES_UI.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </Labelled>

          {options.canSeeAllUsers ? (
            <Labelled label="Submitted by">
              <Select
                value={value("createdById")}
                onChange={(e) => apply("createdById", e.target.value)}
              >
                <option value="">Anyone</option>
                {options.users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Select>
            </Labelled>
          ) : null}

          <Labelled label="Routing">
            <Select value={value("routing")} onChange={(e) => apply("routing", e.target.value)}>
              <option value="">All</option>
              <option value="DIRECT">Direct</option>
              <option value="VIA_DUBAI_PARTNER">Via Dubai partner</option>
            </Select>
          </Labelled>

          <div className="flex items-end sm:col-span-2 lg:col-span-4">
            <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
              <IconX className="h-3.5 w-3.5" />
              Clear all filters
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Labelled({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block space-y-1", className)}>
      <span className="block text-[11px] font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
