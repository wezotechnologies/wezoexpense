import "server-only";

import { compare, genSalt, hash } from "bcryptjs";

/** bcrypt cost factor — spec 14 requires >= 12. */
export const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  const salt = await genSalt(BCRYPT_COST);
  return hash(plain, salt);
}

export async function verifyPassword(
  plain: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    return await compare(plain, passwordHash);
  } catch {
    return false;
  }
}

/**
 * Password policy for user creation / reset. Deliberately modest: this is a
 * small internal tool and the Superadmin sets colleagues' initial passwords.
 */
export const PASSWORD_MIN_LENGTH = 10;

export function describePasswordPolicy(): string {
  return `At least ${PASSWORD_MIN_LENGTH} characters, including a letter and a number.`;
}

export function isPasswordAcceptable(plain: string): boolean {
  return (
    plain.length >= PASSWORD_MIN_LENGTH &&
    /[a-zA-Z]/.test(plain) &&
    /[0-9]/.test(plain)
  );
}
