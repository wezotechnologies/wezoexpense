import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { ChangePasswordForm } from "@/components/change-password-form";
import { Alert } from "@/components/ui/primitives";
import { getSessionUser } from "@/lib/rbac";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Set your password" };

/**
 * Forced password change on first login (spec 16).
 *
 * Deliberately outside the (app) route group: the app shell redirects here
 * while `mustChangePassword` is set, so sharing that layout would loop.
 */
export default async function WelcomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.mustChangePassword) redirect("/dashboard");

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo className="h-8 w-auto text-ink" />
          <h1 className="mt-6 text-lg font-semibold tracking-tight">
            Welcome, {user.name.split(" ")[0]}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Choose a password only you know before you start.
          </p>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
          <Alert tone="accent" className="mb-4">
            Your account was created with a temporary password. Please replace it
            now.
          </Alert>

          <ChangePasswordForm redirectTo="/dashboard" submitLabel="Set password" />
        </div>
      </div>
    </main>
  );
}
