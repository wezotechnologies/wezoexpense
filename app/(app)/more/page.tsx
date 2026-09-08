import Link from "next/link";
import type { Metadata } from "next";

import { Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { IconChevronRight } from "@/components/icons";
import { NavIcon } from "@/components/nav-icon";
import { GROUP_LABELS, navItemsFor, type NavItem } from "@/lib/nav";
import { requireUser } from "@/lib/rbac";

export const metadata: Metadata = { title: "More" };

/**
 * The mobile "More" sheet: everything that doesn't fit in the bottom bar.
 * On desktop the sidebar already shows all of this.
 */
export default async function MorePage() {
  const user = await requireUser();
  const items = navItemsFor(user.role);

  const groups: Array<NavItem["group"]> = ["main", "manage", "admin"];

  return (
    <>
      <PageHeader title="More" description="Everything else in the app." />

      <div className="space-y-4">
        {groups.map((group) => {
          const groupItems = items.filter((i) => i.group === group);
          if (groupItems.length === 0) return null;

          return (
            <Card key={group} className="overflow-hidden">
              <CardHeader title={GROUP_LABELS[group] || "Main"} />
              <ul className="divide-y divide-line">
                {groupItems.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
                    >
                      <NavIcon
                        name={item.icon}
                        className="h-[18px] w-[18px] text-ink-muted"
                      />
                      <span className="flex-1 text-sm">{item.label}</span>
                      <IconChevronRight className="h-4 w-4 text-ink-muted/60" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}

        <Card className="overflow-hidden">
          <CardHeader title="You" />
          <ul className="divide-y divide-line">
            <li>
              <Link
                href="/account"
                className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
              >
                <NavIcon name="settings" className="h-[18px] w-[18px] text-ink-muted" />
                <span className="flex-1 text-sm">Your account &amp; password</span>
                <IconChevronRight className="h-4 w-4 text-ink-muted/60" />
              </Link>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
