/**
 * Skeleton shown while a screen's data loads. Mirrors the common page shape
 * (heading, tiles, list) so the layout doesn't jump when content arrives.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-6 space-y-2">
        <div className="h-6 w-44 rounded bg-surface-2" />
        <div className="h-3.5 w-72 rounded bg-surface-2/70" />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface px-4 py-3">
            <div className="h-2.5 w-20 rounded bg-surface-2" />
            <div className="mt-2 h-6 w-24 rounded bg-surface-2" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <div className="h-3.5 w-32 rounded bg-surface-2" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
          >
            <div className="h-3 flex-1 rounded bg-surface-2/70" />
            <div className="h-3 w-20 rounded bg-surface-2/70" />
            <div className="h-3 w-14 rounded bg-surface-2/70" />
          </div>
        ))}
      </div>
    </div>
  );
}
