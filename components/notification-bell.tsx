"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { IconBell } from "@/components/icons";
import { cx } from "@/components/ui/primitives";
import { formatRelative } from "@/lib/format";

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

const TONE: Record<string, string> = {
  SUBMISSION_PENDING: "bg-pending",
  SUBMISSION_APPROVED: "bg-approved",
  SUBMISSION_REJECTED: "bg-rejected",
  BUDGET_THRESHOLD: "bg-pending",
  PERIOD_LOCKED: "bg-info",
  SYSTEM: "bg-ink-muted",
};

/** Notification centre (spec 11). Polls gently; this is a low-traffic tool. */
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/notifications?limit=15");
      if (!response.ok) return;
      const data = await response.json();
      setItems(data.notifications ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      // Offline — keep whatever is on screen.
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh the badge occasionally so approvers notice new submissions.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshCount();
    }, 60_000);
    return () => window.clearInterval(id);

    async function refreshCount() {
      try {
        const response = await fetch("/api/notifications?unreadOnly=1&limit=1");
        if (!response.ok) return;
        const data = await response.json();
        setUnread(data.unread ?? 0);
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;

    const onClick = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
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

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) await load();
  }

  async function markAllRead() {
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, readAt: new Date().toISOString() })));
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      router.refresh();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        aria-expanded={open}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <IconBell className="h-[18px] w-[18px]" />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 min-w-[15px] rounded-full bg-accent px-1 text-[9px] font-bold leading-[15px] text-accent-contrast">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-11 z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-xl shadow-black/40"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-xs font-semibold">Notifications</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={markAllRead}
                className="text-[11px] text-accent hover:underline"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loading && items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-ink-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-ink-muted">
                Nothing yet. Approvals and budget alerts will show up here.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item) => {
                  const content = (
                    <div
                      className={cx(
                        "flex gap-2.5 px-3 py-2.5",
                        !item.readAt && "bg-accent-soft/40",
                      )}
                    >
                      <span
                        className={cx(
                          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                          TONE[item.kind] ?? "bg-ink-muted",
                        )}
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-medium leading-snug">{item.title}</p>
                        {item.body ? (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-muted">
                            {item.body}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[10px] text-ink-muted/70">
                          {formatRelative(item.createdAt)}
                        </p>
                      </div>
                    </div>
                  );

                  return (
                    <li key={item.id}>
                      {item.link ? (
                        <Link
                          href={item.link}
                          onClick={() => setOpen(false)}
                          className="block hover:bg-surface-2"
                        >
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
