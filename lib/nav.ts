import { Role } from "@/generated/prisma/enums";

/**
 * Navigation model, shared by the sidebar, the mobile bar and the "more" sheet.
 *
 * Client-safe: `generated/prisma/enums` is a plain constants file with no
 * imports, so this never drags the database client into the browser bundle.
 *
 * Visibility here is presentation only. Every route re-checks authorisation on
 * the server — hiding a link is a convenience, never the control (spec 3).
 */

export type NavItem = {
  href: string;
  label: string;
  /** Shorter label for the mobile bar. */
  short?: string;
  icon: string;
  roles: Role[];
  group: "main" | "manage" | "admin";
  /** Shown in the mobile bottom bar. */
  primary?: boolean;
};

const ALL: Role[] = [Role.SUPERADMIN, Role.ADMIN, Role.EMPLOYEE];
const ADMIN_PLUS: Role[] = [Role.SUPERADMIN, Role.ADMIN];
const SUPERADMIN: Role[] = [Role.SUPERADMIN];

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: ALL, group: "main", primary: true },
  { href: "/add", label: "Add / Upload", short: "Add", icon: "plus", roles: ALL, group: "main", primary: true },
  { href: "/transactions", label: "Transactions", short: "Txns", icon: "list", roles: ALL, group: "main", primary: true },
  { href: "/approvals", label: "Approvals", icon: "inbox", roles: ADMIN_PLUS, group: "main", primary: true },
  { href: "/clients", label: "Clients & payments", short: "Clients", icon: "briefcase", roles: ADMIN_PLUS, group: "main" },
  { href: "/reports", label: "Reports", icon: "chart", roles: ALL, group: "main" },

  { href: "/budgets", label: "Budgets", icon: "target", roles: ADMIN_PLUS, group: "manage" },
  { href: "/recurring", label: "Recurring", icon: "repeat", roles: ADMIN_PLUS, group: "manage" },
  { href: "/salary", label: "Salary calculator", short: "Salary", icon: "wallet", roles: ADMIN_PLUS, group: "manage" },
  { href: "/directories", label: "Categories & vendors", short: "Directories", icon: "tag", roles: ADMIN_PLUS, group: "manage" },
  { href: "/import", label: "Import CSV", icon: "upload", roles: ADMIN_PLUS, group: "manage" },
  { href: "/close", label: "Monthly close", icon: "lock", roles: ADMIN_PLUS, group: "manage" },

  { href: "/audit", label: "Audit log", icon: "shield", roles: ADMIN_PLUS, group: "admin" },
  { href: "/users", label: "Users", icon: "users", roles: SUPERADMIN, group: "admin" },
  { href: "/settings", label: "Settings", icon: "settings", roles: SUPERADMIN, group: "admin" },
];

export const GROUP_LABELS: Record<NavItem["group"], string> = {
  main: "",
  manage: "Manage",
  admin: "Administration",
};

export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Up to four primary destinations for the mobile bottom bar. */
export function primaryNavFor(role: Role): NavItem[] {
  return navItemsFor(role)
    .filter((i) => i.primary)
    .slice(0, 4);
}

/** True when `pathname` is inside `href`'s section. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/" || pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
