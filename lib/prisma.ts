import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Single Prisma client per process (spec 17 — keep it cheap to run).
 * Prisma 7 requires a driver adapter; there is no Rust query engine.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return new PrismaClient({
    adapter,
    log: env.isProduction ? ["error"] : ["error", "warn"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (!env.isProduction) {
  // Survive HMR in dev without opening a new pool on every reload.
  globalForPrisma.prisma = prisma;
}
