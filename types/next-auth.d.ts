import type { DefaultSession } from "next-auth";
import type { Role } from "@/generated/prisma/enums";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
  }
}

/**
 * `next-auth/jwt` only re-exports `@auth/core/jwt`, so the augmentation has to
 * target the declaring module for the extra claims to merge into `JWT`.
 */
declare module "@auth/core/jwt" {
  interface JWT {
    uid?: string;
    role?: Role;
  }
}
