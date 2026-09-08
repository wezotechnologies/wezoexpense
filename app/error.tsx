"use client";

import { useEffect } from "react";

/**
 * Route error boundary. Shows a recoverable message rather than a stack trace:
 * this app holds financial data, and internals should not be on screen.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] route error:", error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-expense/30 bg-expense/10">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            className="h-5 w-5 text-expense"
            aria-hidden="true"
          >
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
          </svg>
        </div>

        <h1 className="text-lg font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          Nothing was saved. Try again — if it keeps happening, send this
          reference to whoever looks after the app.
        </p>

        {error.digest ? (
          <p className="mt-3 font-mono text-[11px] text-ink-muted/70">
            Reference: {error.digest}
          </p>
        ) : null}

        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:bg-accent-strong"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm hover:border-ink-muted/50"
          >
            Back to the dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
