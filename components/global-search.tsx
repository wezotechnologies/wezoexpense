"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { IconSearch } from "@/components/icons";

/**
 * Global search (spec 11): vendor, amount, note or payment label.
 *
 * Submits into the Transactions screen, which owns the actual query, so there
 * is one filtering implementation rather than two. Cmd/Ctrl-K focuses it.
 */
export function GlobalSearch() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = value.trim();
    router.push(q ? `/transactions?q=${encodeURIComponent(q)}` : "/transactions");
  }

  return (
    <form onSubmit={submit} className="hidden min-w-0 flex-1 lg:block lg:max-w-sm">
      <label className="sr-only" htmlFor="global-search">
        Search transactions
      </label>
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <input
          id="global-search"
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search vendor, amount, note…"
          className="h-9 w-full rounded-lg border border-line bg-surface-2 pl-8 pr-12 text-sm placeholder:text-ink-muted/70 focus:border-accent focus:outline-none"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1 text-[10px] text-ink-muted/70 sm:block">
          ⌘K
        </kbd>
      </div>
    </form>
  );
}
