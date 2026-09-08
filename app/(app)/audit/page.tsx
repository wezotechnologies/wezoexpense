import Link from "next/link";
import type { Metadata } from "next";
import { z } from "zod";

import { Badge, Card, EmptyState, Input, PageHeader } from "@/components/ui/primitives";
import { IconShield } from "@/components/icons";
import { prisma } from "@/lib/prisma";
import { formatDateTime, titleCase } from "@/lib/format";
import { isSuperadmin, requireCapability } from "@/lib/rbac";
import type { Prisma } from "@/generated/prisma/client";

export const metadata: Metadata = { title: "Audit log" };

const querySchema = z.object({
  q: z.string().max(120).optional(),
  action: z.string().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const PER_PAGE = 60;

/** Tone by what the action did, so a scan picks out approvals and deletions. */
function toneFor(action: string): "approved" | "rejected" | "pending" | "info" | "neutral" {
  if (action.startsWith("APPROVE")) return "approved";
  if (action.startsWith("REJECT") || action.startsWith("DELETE")) return "rejected";
  if (action.startsWith("CREATE") || action.startsWith("IMPORT")) return "info";
  if (
    action.startsWith("CHANGE_ROLE") ||
    action.startsWith("ADD_USER") ||
    action.includes("PASSWORD") ||
    action.includes("PERIOD")
  ) {
    return "pending";
  }
  return "neutral";
}

export default async function AuditPage(props: PageProps<"/audit">) {
  const user = await requireCapability("viewAudit");
  const searchParams = await props.searchParams;

  const parsed = querySchema.safeParse(searchParams);
  const filter = parsed.success ? parsed.data : querySchema.parse({});

  const where: Prisma.AuditLogWhereInput = {
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.q
      ? {
          OR: [
            { action: { contains: filter.q, mode: "insensitive" } },
            { entity: { contains: filter.q, mode: "insensitive" } },
            { entityId: { contains: filter.q, mode: "insensitive" } },
            { actor: { name: { contains: filter.q, mode: "insensitive" } } },
            { actor: { email: { contains: filter.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [total, entries, actions] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * PER_PAGE,
      take: PER_PAGE,
      include: { actor: { select: { name: true, email: true } } },
    }),
    prisma.auditLog.groupBy({ by: ["action"], _count: true }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <>
      <PageHeader
        title="Audit log"
        description={
          isSuperadmin(user)
            ? "Every create, edit, approval, deletion and user change. Append-only — entries can never be altered or removed."
            : "Read-only record of every change made in the app."
        }
      />

      <form className="mb-4 flex flex-wrap gap-2" action="/audit">
        <Input
          name="q"
          type="search"
          defaultValue={filter.q ?? ""}
          placeholder="Search by person, action or record id…"
          className="min-w-0 flex-1 sm:max-w-xs"
          aria-label="Search the audit log"
        />
        <select
          name="action"
          defaultValue={filter.action ?? ""}
          aria-label="Filter by action"
          className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm"
        >
          <option value="">All actions</option>
          {actions
            .sort((a, b) => a.action.localeCompare(b.action))
            .map((a) => (
              <option key={a.action} value={a.action}>
                {titleCase(a.action)} ({a._count})
              </option>
            ))}
        </select>
        <button
          type="submit"
          className="h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-contrast"
        >
          Search
        </button>
      </form>

      <Card className="overflow-hidden">
        {entries.length === 0 ? (
          <EmptyState
            icon={<IconShield className="h-7 w-7" />}
            title="Nothing recorded yet"
            description="Actions appear here as soon as people start using the app."
          />
        ) : (
          <ul className="divide-y divide-line">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
                <Badge tone={toneFor(entry.action)}>{titleCase(entry.action)}</Badge>

                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{entry.actor?.name ?? "—"}</span>
                    <span className="text-ink-muted">
                      {" "}
                      · {entry.entity}
                      {entry.entityId ? (
                        entry.entity === "Transaction" ? (
                          <>
                            {" "}
                            <Link
                              href={`/transactions?id=${entry.entityId}`}
                              className="text-accent hover:underline"
                            >
                              {entry.entityId.slice(-8)}
                            </Link>
                          </>
                        ) : (
                          ` ${entry.entityId.slice(-8)}`
                        )
                      ) : null}
                    </span>
                  </p>
                  {entry.after || entry.before ? (
                    <p className="mt-0.5 truncate font-mono text-[10px] text-ink-muted/70">
                      {summarise(entry.before, entry.after)}
                    </p>
                  ) : null}
                </div>

                <time
                  dateTime={entry.createdAt.toISOString()}
                  className="shrink-0 text-[11px] text-ink-muted"
                >
                  {formatDateTime(entry.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {totalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-between" aria-label="Pagination">
          <p className="text-xs text-ink-muted">
            Page {filter.page} of {totalPages} · {total} entries
          </p>
          <div className="flex gap-2">
            {filter.page > 1 ? (
              <Link
                href={`/audit?page=${filter.page - 1}${filter.q ? `&q=${encodeURIComponent(filter.q)}` : ""}`}
                className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-ink-muted/50"
              >
                Previous
              </Link>
            ) : null}
            {filter.page < totalPages ? (
              <Link
                href={`/audit?page=${filter.page + 1}${filter.q ? `&q=${encodeURIComponent(filter.q)}` : ""}`}
                className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-ink-muted/50"
              >
                Next
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}

/** One-line "what changed" for the row, kept short enough to scan. */
function summarise(before: unknown, after: unknown): string {
  const pick = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : null;

  const b = pick(before);
  const a = pick(after);

  if (a && b) {
    const changed = Object.keys(a).filter(
      (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
    if (changed.length === 0) return "no field changes";
    return changed
      .slice(0, 4)
      .map((key) => `${key}: ${format(b[key])} → ${format(a[key])}`)
      .join("  ·  ");
  }

  const single = a ?? b;
  if (!single) return "";
  return Object.entries(single)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${format(value)}`)
    .join("  ·  ");
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}
