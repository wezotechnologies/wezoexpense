"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Select,
  Spinner,
  cx,
} from "@/components/ui/primitives";
import { IconPlus, IconUsers } from "@/components/icons";
import { formatDate, initials } from "@/lib/format";

/** User management (spec 9.11) — Superadmin only. */

type User = {
  id: string;
  name: string;
  email: string;
  role: "SUPERADMIN" | "ADMIN" | "EMPLOYEE";
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  submissionCount: number;
};

const ROLE_LABEL = {
  SUPERADMIN: "Superadmin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
} as const;

export function UsersManager({
  users,
  currentUserId,
}: {
  users: User[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // New user form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<User["role"]>("EMPLOYEE");
  const [password, setPassword] = useState("");

  async function send(body: unknown, method: "POST" | "PATCH", key: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/users", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "That could not be saved.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addUser(event: React.FormEvent) {
    event.preventDefault();
    const ok = await send({ name, email, role, password }, "POST", "new");
    if (ok) {
      setNotice(
        `${name} can now sign in with the password you set. They'll be asked to change it immediately.`,
      );
      setName("");
      setEmail("");
      setPassword("");
      setRole("EMPLOYEE");
    }
  }

  async function resetPassword(user: User) {
    const next = prompt(
      `Set a new password for ${user.name}.\n\nAt least 10 characters, including a letter and a number. They will be asked to change it on their next sign-in.`,
    );
    if (!next) return;
    const ok = await send({ id: user.id, newPassword: next }, "PATCH", user.id);
    if (ok) setNotice(`Password reset for ${user.name}.`);
  }

  const activeSuperadmins = users.filter(
    (u) => u.role === "SUPERADMIN" && u.isActive,
  ).length;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_1fr]">
      <Card>
        <CardHeader
          title="Add a person"
          description="They sign in with the password you set here."
        />
        <form onSubmit={addUser} className="space-y-3 p-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Full name
            </span>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Email</span>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">Role</span>
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as User["role"])}
            >
              <option value="EMPLOYEE">Employee — submits, sees only their own</option>
              <option value="ADMIN">Admin — approves, reports, manages lists</option>
              <option value="SUPERADMIN">Superadmin — full control</option>
            </Select>
          </label>

          <label className="block space-y-1">
            <span className="block text-[11px] font-medium text-ink-muted">
              Temporary password
            </span>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 10 characters"
              minLength={10}
              required
            />
          </label>

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={busy === "new" || !name || !email || password.length < 10}
          >
            {busy === "new" ? <Spinner /> : <IconPlus className="h-4 w-4" />}
            Add person
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="People" description={`${users.length} accounts`} />

        {users.length === 0 ? (
          <div className="p-8 text-center">
            <IconUsers className="mx-auto h-7 w-7 text-ink-muted" />
            <p className="mt-2 text-sm">No accounts yet</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const lastSuperadmin =
                user.role === "SUPERADMIN" && activeSuperadmins <= 1;

              return (
                <li key={user.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-[11px] font-semibold">
                      {initials(user.name)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <p
                        className={cx(
                          "flex flex-wrap items-center gap-1.5 text-sm font-medium",
                          !user.isActive && "text-ink-muted",
                        )}
                      >
                        <span className={cx(!user.isActive && "line-through")}>
                          {user.name}
                        </span>
                        {isSelf ? <Badge tone="accent">You</Badge> : null}
                        {!user.isActive ? <Badge tone="neutral">Deactivated</Badge> : null}
                        {user.mustChangePassword ? (
                          <Badge tone="pending">Must change password</Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                        {user.email} · {user.submissionCount} submission
                        {user.submissionCount === 1 ? "" : "s"} · since{" "}
                        {formatDate(user.createdAt)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-11">
                    <Select
                      value={user.role}
                      aria-label={`Role for ${user.name}`}
                      disabled={busy === user.id || isSelf || lastSuperadmin}
                      onChange={(e) =>
                        send({ id: user.id, role: e.target.value }, "PATCH", user.id)
                      }
                      className="h-8 w-auto min-w-32 text-xs"
                    >
                      {Object.entries(ROLE_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === user.id}
                      onClick={() => resetPassword(user)}
                    >
                      Reset password
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === user.id || isSelf || (user.isActive && lastSuperadmin)}
                      onClick={() =>
                        send(
                          { id: user.id, isActive: !user.isActive },
                          "PATCH",
                          user.id,
                        )
                      }
                    >
                      {user.isActive ? "Deactivate" : "Reactivate"}
                    </Button>

                    {isSelf ? (
                      <span className="text-[11px] text-ink-muted">
                        You can&apos;t change your own role or deactivate yourself
                      </span>
                    ) : lastSuperadmin && user.isActive ? (
                      <span className="text-[11px] text-ink-muted">
                        The only Superadmin — promote someone else first
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
