"use server";

import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/auth";

export type LoginState = { error?: string };

const schema = z.object({
  email: z.email({ error: "Enter a valid email address." }),
  password: z.string().min(1, { error: "Enter your password." }),
  next: z.string().optional(),
});

/**
 * Credentials sign-in. Returns a single generic message on failure so the form
 * cannot be used to work out which emails exist (spec 14).
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your details." };
  }

  // Only allow relative paths so `?next=` can't be used as an open redirect.
  const raw = parsed.data.next ?? "";
  const redirectTo =
    raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo,
    });
  } catch (error) {
    // A successful sign-in throws NEXT_REDIRECT, which must propagate.
    if (error instanceof AuthError) {
      return { error: "Incorrect email or password." };
    }
    throw error;
  }

  return {};
}
