"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { IconRefresh } from "@/components/icons";
import { cx } from "@/components/ui/primitives";

/**
 * Pulls fresh server data for whatever route is on screen.
 *
 * An installed PWA is opened and closed, not reloaded. iOS keeps the page alive
 * in the background for days, so figures on screen can be arbitrarily old with
 * nothing on the page to say so — the app looks live because it is responsive.
 * Three things fix that here:
 *
 *  - returning to the app refreshes automatically, if enough time has passed
 *    that the data could plausibly have moved;
 *  - regaining connectivity refreshes, because what is on screen was rendered
 *    while offline;
 *  - the button refreshes on demand, and reports how old the data is, for the
 *    times you want to be *sure* rather than to assume.
 *
 * `router.refresh()` re-requests the current route's Server Components and
 * merges the result, so client state and scroll position survive — unlike a
 * reload, which would also cost a full app boot on a phone.
 */

/** Below this, a resume is treated as continuing the same session. */
const STALE_AFTER_MS = 30_000;

function describeAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The timestamp is a ref, not state: it is read by event handlers rather than
  // rendered, so keeping it out of state stops every sync from tearing down and
  // re-registering the listeners below. What *is* rendered is the label, which
  // a timer ages independently.
  // Seeded on mount rather than at render: reading the clock while rendering is
  // impure, and the honest timestamp is when this render was committed anyway.
  const syncedAtRef = useRef(0);
  const [age, setAge] = useState("just now");

  const sync = useCallback(() => {
    startTransition(() => {
      router.refresh();
      syncedAtRef.current = Date.now();
      setAge("just now");
    });
  }, [router]);

  useEffect(() => {
    syncedAtRef.current = Date.now();

    // Resuming an installed app is the moment stale data is most likely and
    // least obvious. Refresh only if it has been long enough to matter, so
    // switching apps for a few seconds does not cause a burst of requests.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - syncedAtRef.current < STALE_AFTER_MS) return;
      sync();
    };

    // Anything rendered while offline was rendered from cache by definition.
    const onOnline = () => sync();

    // The worker sends this after an upgrade evicts its caches.
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === "REFRESH") sync();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    // Messages from the worker are queued until a listener is *known* to be
    // live. With addEventListener — as opposed to assigning onmessage — that
    // only happens once this is called, so without it the worker's post-upgrade
    // REFRESH can be delivered to nobody.
    navigator.serviceWorker?.startMessages();
    const timer = window.setInterval(
      () => setAge(describeAge(Date.now() - syncedAtRef.current)),
      30_000,
    );

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
      window.clearInterval(timer);
    };
  }, [sync]);

  const label = pending ? "Syncing…" : `Sync now — updated ${age}`;

  return (
    <button
      type="button"
      onClick={sync}
      disabled={pending}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-9 w-9 items-center justify-center rounded-lg",
        "text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink",
        "disabled:cursor-default disabled:opacity-60",
      )}
    >
      <IconRefresh
        className={cx("h-[18px] w-[18px]", pending && "animate-spin")}
      />
    </button>
  );
}
