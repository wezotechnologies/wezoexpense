import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="max-w-sm text-center">
        <p className="text-3xl font-semibold tracking-tight text-accent">404</p>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">
          We couldn&apos;t find that page
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          The link may be out of date, or the record may have been deleted.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast hover:bg-accent-strong"
        >
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
