"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Button,
  Field,
  Input,
  Spinner,
} from "@/components/ui/primitives";

/**
 * Password change, used both for the forced first-login change (spec 16) and
 * for a voluntary change from the account screen.
 */
export function ChangePasswordForm({
  redirectTo = "/dashboard",
  submitLabel = "Update password",
}: {
  redirectTo?: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== newPassword;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/me/password", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(data.error ?? "Could not update your password.");
        return;
      }

      setDone(true);
      // The session's mustChangePassword flag is re-read server-side, so a
      // refresh is enough to unlock the rest of the app.
      router.refresh();
      router.push(redirectTo);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {done ? <Alert tone="success">Password updated.</Alert> : null}

      <Field label="Current password" htmlFor="currentPassword" required>
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
      </Field>

      <Field
        label="New password"
        htmlFor="newPassword"
        required
        hint="At least 10 characters, including a letter and a number."
      >
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={10}
          required
        />
      </Field>

      <Field
        label="Confirm new password"
        htmlFor="confirmPassword"
        required
        error={mismatch ? "The two passwords don't match." : undefined}
      >
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </Field>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        disabled={saving || mismatch}
      >
        {saving ? (
          <>
            <Spinner /> Saving…
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  );
}
