import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Single Prisma client per process (spec 17 — keep it cheap to run).
 * Prisma 7 requires a driver adapter; there is no Rust query engine.
 *
 * The client is created **lazily**, on first use, rather than at module load.
 * That matters for more than tidiness: `next build` imports every route module
 * to collect its configuration, so an eagerly-constructed client made
 * DATABASE_URL a *build-time* requirement — and the build then failed on
 * /api/health with "Missing required environment variable DATABASE_URL" on any
 * machine without a .env, CI included. Deferring construction means the build
 * needs no database configuration at all, and the connection string is only
 * read when a query is actually run.
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

function getClient(): PrismaClient {
  // Reuse across HMR reloads in dev so a pool isn't opened per edit.
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

/**
 * Behaves exactly like a PrismaClient. Every property access resolves against
 * the real client, constructing it on the first one.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    // Resolve against the client as receiver, not the proxy, so Prisma's own
    // internal property access behaves normally.
    const value = Reflect.get(client, property, client);
    // Methods must stay bound to the client, not to the proxy.
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, property) {
    return Reflect.has(getClient(), property);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getClient());
  },
});
