import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline" };

/**
 * Precached by the service worker so the installed app always opens, even with
 * no connection (spec 13).
 */
export default function OfflinePage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-6 w-6 text-ink-muted"
            aria-hidden="true"
          >
            <path
              d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a9 9 0 0 1 3-2M19 13a9 9 0 0 0-6-2.9M12 20h.01"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h1 className="text-lg font-semibold tracking-tight">You&apos;re offline</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Wezo Expenses needs a connection to load your books. Anything you
          saved while offline is queued on this device and will sync
          automatically once you&apos;re back online.
        </p>
      </div>
    </main>
  );
}
