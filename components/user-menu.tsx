"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { IconLogout, IconSettings } from "@/components/icons";
import { cx } from "@/components/ui/primitives";
import { initials } from "@/lib/format";

const ROLE_LABEL: Record<string, string> = {
  SUPERADMIN: "Superadmin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
};

export function UserMenu({
  name,
  email,
  role,
}: {
  name: string;
  email: string;
  role: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Signing out clears the service worker caches too, so no financial data is
   * left on a shared device (spec 14).
   */
  async function purgeAndSignOut(event: React.FormEvent<HTMLFormElement>) {
    try {
      const registration = await navigator.serviceWorker?.ready;
      registration?.active?.postMessage({ type: "PURGE" });
    } catch {
      // No worker registered — nothing cached to clear.
    }
    // Let the form submit to the sign-out action.
    void event;
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface-2 text-[11px] font-semibold text-ink transition-colors hover:border-ink-muted/50"
      >
        {initials(name)}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-lg border border-line bg-surface shadow-xl shadow-black/40">
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-xs font-semibold">{name}</p>
            <p className="truncate text-[11px] text-ink-muted">{email}</p>
            <p className="mt-1 inline-flex rounded-md border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
              {ROLE_LABEL[role] ?? role}
            </p>
          </div>

          <div className="p-1">
            <Link
              href="/account"
              onClick={() => setOpen(false)}
              className={cx(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-ink-muted",
                "hover:bg-surface-2 hover:text-ink",
              )}
            >
              <IconSettings className="h-4 w-4" />
              Change password
            </Link>

            <form action="/api/auth/signout" method="post" onSubmit={purgeAndSignOut}>
              <SignOutButton />
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Auth.js requires the CSRF token on its sign-out endpoint, so it is fetched
 * when the menu renders rather than embedded in the server-rendered HTML.
 */
function SignOutButton() {
  const [token, setToken] = useState("");

  useEffect(() => {
    fetch("/api/auth/csrf")
      .then((r) => r.json())
      .then((d) => setToken(d.csrfToken ?? ""))
      .catch(() => setToken(""));
  }, []);

  return (
    <>
      <input type="hidden" name="csrfToken" value={token} />
      <input type="hidden" name="callbackUrl" value="/login" />
      <button
        type="submit"
        disabled={!token}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        <IconLogout className="h-4 w-4" />
        Sign out
      </button>
    </>
  );
}
