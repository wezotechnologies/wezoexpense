"use client";

import { useState, useTransition } from "react";

import { IconMoon, IconSun } from "@/components/icons";
import { cx } from "@/components/ui/primitives";

/**
 * Dark/light toggle (spec 4). Dark is the default.
 *
 * The class is flipped on <html> immediately so the change feels instant, then
 * persisted to the user's record so it survives to the next device and is
 * server-rendered on the next visit (no flash).
 */
export function ThemeToggle({ initial }: { initial: "dark" | "light" }) {
  const [theme, setTheme] = useState<"dark" | "light">(initial);
  const [, startTransition] = useTransition();

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("light", next === "light");

    startTransition(async () => {
      try {
        await fetch("/api/me/theme", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme: next }),
        });
      } catch {
        // A failed save is not worth interrupting anyone for; the choice still
        // applies for this session and will be retried on the next toggle.
      }
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      className={cx(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg",
        "text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink",
      )}
    >
      {theme === "dark" ? (
        <IconSun className="h-[18px] w-[18px]" />
      ) : (
        <IconMoon className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
