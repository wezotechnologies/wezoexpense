import "server-only";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Role-based access control (spec 3).
 *
 * Hierarchy: SUPERADMIN > ADMIN > EMPLOYEE.
 *
 * Every capability below mirrors a row of the spec's permission table. Route
 * handlers and Server Components must call `requireUser()` / `requireCapability()`
 * rather than trusting anything sent by the client, and list queries must be
 * narrowed with `transactionScope()` so an Employee can never read another
 * user's rows even if they craft the request by hand.
 */

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  themePref: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const Unauthorized = () => new ApiError(401, "Not signed in.");
export const Forbidden = (what = "You do not have access to this.") =>
  new ApiError(403, what);

/**
 * Resolves the caller from the session cookie and then re-reads them from the
 * database. The DB row — not the JWT claim — is authoritative for `role` and
 * `isActive`, so promotions, demotions and deactivations apply immediately.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      themePref: true,
    },
  });

  if (!user || !user.isActive) return null;
  return user;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw Unauthorized();
  return user;
}

// ---------------------------------------------------------------------------
// Capabilities — one per row of the spec 3 table
// ---------------------------------------------------------------------------

export type Capability =
  | "submit"
  | "useAi"
  | "viewAllTransactions"
  | "approve"
  | "editAnyTransaction"
  | "deleteTransaction"
  | "manageDirectories"
  | "runReports"
  | "manageRecurring"
  | "manageBudgets"
  | "lockPeriod"
  | "unlockPeriod"
  | "manageUsers"
  | "changeRole"
  | "appSettings"
  | "viewAudit"
  | "importCsv"
  | "hardDelete";

const ADMIN_PLUS: Role[] = [Role.SUPERADMIN, Role.ADMIN];
const EVERYONE: Role[] = [Role.SUPERADMIN, Role.ADMIN, Role.EMPLOYEE];
const SUPERADMIN_ONLY: Role[] = [Role.SUPERADMIN];

const CAPABILITIES: Record<Capability, Role[]> = {
  submit: EVERYONE,
  useAi: EVERYONE,
  viewAllTransactions: ADMIN_PLUS,
  approve: ADMIN_PLUS,
  editAnyTransaction: ADMIN_PLUS,
  deleteTransaction: ADMIN_PLUS,
  manageDirectories: ADMIN_PLUS,
  runReports: ADMIN_PLUS,
  manageRecurring: ADMIN_PLUS,
  manageBudgets: ADMIN_PLUS,
  lockPeriod: ADMIN_PLUS,
  importCsv: ADMIN_PLUS,
  viewAudit: ADMIN_PLUS, // Admin read-only; Superadmin full
  unlockPeriod: SUPERADMIN_ONLY,
  manageUsers: SUPERADMIN_ONLY,
  changeRole: SUPERADMIN_ONLY,
  appSettings: SUPERADMIN_ONLY,
  hardDelete: SUPERADMIN_ONLY,
};

export function can(user: { role: Role }, capability: Capability): boolean {
  return CAPABILITIES[capability].includes(user.role);
}

export function isAdminPlus(user: { role: Role }): boolean {
  return user.role === Role.SUPERADMIN || user.role === Role.ADMIN;
}

export function isSuperadmin(user: { role: Role }): boolean {
  return user.role === Role.SUPERADMIN;
}

/** Throws 403 unless the caller holds the capability. */
export function assertCan(user: { role: Role }, capability: Capability): void {
  if (!can(user, capability)) throw Forbidden();
}

/** Convenience: authenticate and authorize in one call. */
export async function requireCapability(
  capability: Capability,
): Promise<SessionUser> {
  const user = await requireUser();
  assertCan(user, capability);
  return user;
}

// ---------------------------------------------------------------------------
// Query scoping — the query-layer half of the guarantee
// ---------------------------------------------------------------------------

/**
 * Where-fragment restricting transaction reads to what the caller may see.
 * Admin/Superadmin see everything; an Employee sees only rows they created.
 * Always excludes soft-deleted rows.
 */
export function transactionScope(user: {
  id: string;
  role: Role;
}): Prisma.TransactionWhereInput {
  const base: Prisma.TransactionWhereInput = { deletedAt: null };
  if (isAdminPlus(user)) return base;
  return { ...base, createdById: user.id };
}

/**
 * May the caller edit this transaction?
 * - Admin/Superadmin: any transaction, unless its period is locked (only the
 *   Superadmin may touch a locked period — spec 7.5).
 * - Employee: only their own, and only while still PENDING.
 */
export function canEditTransaction(
  user: { id: string; role: Role },
  txn: {
    createdById: string;
    status: string;
    periodLocked: boolean;
    deletedAt: Date | null;
  },
): boolean {
  if (txn.deletedAt) return false;
  if (txn.periodLocked && !isSuperadmin(user)) return false;
  if (isAdminPlus(user)) return true;
  return txn.createdById === user.id && txn.status === "PENDING";
}

/** May the caller view this specific transaction (and its receipt)? */
export function canViewTransaction(
  user: { id: string; role: Role },
  txn: { createdById: string },
): boolean {
  return isAdminPlus(user) || txn.createdById === user.id;
}
