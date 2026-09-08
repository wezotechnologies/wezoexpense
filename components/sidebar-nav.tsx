"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NavIcon } from "@/components/nav-icon";
import { cx } from "@/components/ui/primitives";
import { GROUP_LABELS, isActivePath, type NavItem } from "@/lib/nav";

/** Desktop sidebar links. Grouped, with the current section highlighted. */
export function SidebarNav({
  items,
  pendingCount,
}: {
  items: NavItem[];
  pendingCount: number;
}) {
  const pathname = usePathname();
  const groups: Array<NavItem["group"]> = ["main", "manage", "admin"];

  return (
    <nav className="flex flex-col gap-5" aria-label="Main">
      {groups.map((group) => {
        const groupItems = items.filter((i) => i.group === group);
        if (groupItems.length === 0) return null;

        return (
          <div key={group}>
            {GROUP_LABELS[group] ? (
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60">
                {GROUP_LABELS[group]}
              </p>
            ) : null}

            <ul className="space-y-0.5">
              {groupItems.map((item) => {
                const active = isActivePath(pathname, item.href);
                const badge = item.href === "/approvals" ? pendingCount : 0;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-accent-soft font-medium text-accent"
                          : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <NavIcon
                        name={item.icon}
                        className={cx(
                          "h-[18px] w-[18px] shrink-0",
                          active ? "text-accent" : "text-ink-muted group-hover:text-ink",
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                      {badge > 0 ? (
                        <span className="ml-auto rounded-md bg-pending/15 px-1.5 py-0.5 text-[11px] font-semibold text-pending tabular">
                          {badge}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Mobile bottom bar: the primary destinations plus a "More" sheet trigger.
 * Sits above the home indicator via safe-area padding.
 */
export function MobileNav({
  items,
  pendingCount,
}: {
  items: NavItem[];
  pendingCount: number;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href);
          const badge = item.href === "/approvals" ? pendingCount : 0;
          const isAdd = item.href === "/add";

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative flex flex-col items-center gap-0.5 px-1 py-2 text-[10px] font-medium transition-colors",
                  active ? "text-accent" : "text-ink-muted",
                )}
              >
                <span
                  className={cx(
                    "relative flex h-7 w-7 items-center justify-center rounded-lg",
                    isAdd && "bg-accent text-accent-contrast",
                    active && !isAdd && "bg-accent-soft",
                  )}
                >
                  <NavIcon name={item.icon} className="h-[18px] w-[18px]" />
                  {badge > 0 ? (
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-pending px-1 text-[9px] font-bold leading-4 text-black">
                      {badge > 9 ? "9+" : badge}
                    </span>
                  ) : null}
                </span>
                <span className="truncate">{item.short ?? item.label}</span>
              </Link>
            </li>
          );
        })}

        <li>
          <Link
            href="/more"
            aria-current={isActivePath(pathname, "/more") ? "page" : undefined}
            className={cx(
              "flex flex-col items-center gap-0.5 px-1 py-2 text-[10px] font-medium transition-colors",
              isActivePath(pathname, "/more") ? "text-accent" : "text-ink-muted",
            )}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                className="h-[18px] w-[18px]"
                aria-hidden="true"
              >
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </span>
            <span>More</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}
