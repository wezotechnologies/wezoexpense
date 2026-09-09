import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/passwords";

/**
 * Auth.js (NextAuth) v5, credentials provider, JWT sessions (spec 2).
 *
 * The JWT carries identity plus a *hint* of the role for cheap UI decisions.
 * It is never the authority: `lib/rbac.ts` re-reads role and isActive from the
 * database on every protected request, so a role change or deactivation by the
 * Superadmin takes effect on the very next request rather than when the token
 * happens to refresh.
 *
 * The config is supplied as a *function*, which Auth.js evaluates per request
 * rather than at import. That keeps `AUTH_SECRET` a runtime requirement: built
 * eagerly, it became a build-time one, and `next build` then failed collecting
 * /api/cron/recurring on any machine without a .env — CI included. The
 * explicit error from lib/env is preserved; it simply fires when a request
 * arrives instead of when the bundle is compiled.
 */

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  secret: env.authSecret,
  trustHost: true,
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  cookies: {
    sessionToken: {
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.isProduction, // secure, httpOnly cookies (spec 14)
      },
    },
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const email = parsed.data.email.toLowerCase().trim();
        const user = await prisma.user.findUnique({ where: { email } });

        // Same failure shape for "no such user" and "wrong password" so the
        // login form cannot be used to enumerate accounts.
        if (!user || !user.isActive) return null;

        const ok = await verifyPassword(parsed.data.password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id as string;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid;
      if (token.role) session.user.role = token.role;
      return session;
    },
  },
}));
