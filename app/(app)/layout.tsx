import Link from "next/link";
import { redirect } from "next/navigation";

import { NotificationBell } from "@/components/notification-bell";
import { PwaProvider } from "@/components/pwa-provider";
import { MobileNav, SidebarNav } from "@/components/sidebar-nav";
import { SyncButton } from "@/components/sync-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { GlobalSearch } from "@/components/global-search";
import { prisma } from "@/lib/prisma";
import { navItemsFor, primaryNavFor } from "@/lib/nav";
import { getSessionUser, isAdminPlus } from "@/lib/rbac";
import { TxnStatus } from "@/generated/prisma/enums";
import { Logo } from "@/components/logo";

/**
 * Authenticated app shell.
 *
 * The proxy already bounced anonymous visitors, but this re-checks on the
 * server: the proxy only sees whether a cookie exists, while this resolves the
 * real user and their current role (spec 14).
 */
export default async function AppLayout({
  children,
}: LayoutProps<"/">) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Forced password change on first login (spec 16) — nothing else is reachable
  // until it is done. /welcome sits outside this layout, so there is no loop.
  if (user.mustChangePassword) redirect("/welcome");

  const [pendingCount, unread] = await Promise.all([
    isAdminPlus(user)
      ? prisma.transaction.count({
          where: { status: TxnStatus.PENDING, deletedAt: null },
        })
      : Promise.resolve(0),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  const items = navItemsFor(user.role);
  const primary = primaryNavFor(user.role);

  return (
    <div className="flex min-h-dvh flex-col">
      <PwaProvider />

      <div className="flex flex-1">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
          <Link href="/dashboard" className="mb-6 flex items-center px-2">
            <Logo className="h-7 w-auto text-ink" />
          </Link>

          <div className="flex-1 overflow-y-auto">
            <SidebarNav items={items} pendingCount={pendingCount} />
          </div>

          <p className="px-3 pt-4 text-[10px] text-ink-muted/50">
            Wezo Expense Tracker · INR books
          </p>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* `viewport-fit=cover` lets the page fill a notched screen, which
              means an installed PWA draws *underneath* the status bar. Without
              the top inset the header sat on top of the clock and battery, and
              the user menu — the only route to Sign out — could not be tapped
              at all. The height grows by the inset so the 3.5rem content row is
              preserved; on every other device the inset is 0 and nothing moves. */}
          <header
            className="sticky top-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center gap-2 border-b border-line bg-canvas/90 px-3 pt-[env(safe-area-inset-top)] backdrop-blur sm:px-5"
          >
            <Link href="/dashboard" className="lg:hidden">
              <Logo className="h-6 w-auto text-ink" />
            </Link>

            <div className="ml-auto flex items-center gap-1 lg:ml-0 lg:w-full">
              <GlobalSearch />
              <div className="flex items-center gap-1 lg:ml-auto">
                <SyncButton />
                <ThemeToggle initial={user.themePref === "light" ? "light" : "dark"} />
                <NotificationBell initialUnread={unread} />
                <UserMenu name={user.name} email={user.email} role={user.role} />
              </div>
            </div>
          </header>

          {/* pb-20 keeps content clear of the mobile bottom bar */}
          <main className="flex-1 px-3 pb-24 pt-4 sm:px-5 sm:pt-6 lg:pb-10">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>
      </div>

      <MobileNav items={primary} pendingCount={pendingCount} />
    </div>
  );
}
