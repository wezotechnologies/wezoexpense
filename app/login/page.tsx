import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { getSessionUser } from "@/lib/rbac";
import { LoginForm } from "./login-form";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/dashboard");

  const { next } = await props.searchParams;
  const nextPath = typeof next === "string" ? next : undefined;

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="h-8 w-auto text-ink" />
          <h1 className="mt-6 text-lg font-semibold tracking-tight">
            Expense &amp; Income Tracker
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Sign in to record and review Wezo&apos;s books.
          </p>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5 sm:p-6">
          <LoginForm next={nextPath} />
        </div>

        <p className="mt-5 text-center text-xs text-ink-muted">
          Lost your password? Ask a Superadmin to reset it for you.
        </p>
      </div>
    </main>
  );
}
