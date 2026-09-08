import { prisma } from "@/lib/prisma";
import { env, isAiConfigured, isAzureConfigured } from "@/lib/env";

/**
 * GET /api/health — liveness/readiness probe.
 *
 * Deliberately unauthenticated (exempted in proxy.ts) because it is called by
 * the deploy script before traffic is switched, and by any load-balancer probe.
 * It therefore leaks nothing: no counts, no names, no configuration values —
 * only whether each dependency answers.
 *
 * `ready` is the gate. It is false unless the database actually responds, so a
 * release that boots but cannot reach Postgres never receives traffic.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  let database = false;
  try {
    // Cheapest possible round-trip that proves the pool works.
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch (error) {
    console.error("[health] database unreachable:", error);
  }

  const body = {
    status: database ? "ok" : "degraded",
    ready: database,
    checks: {
      database,
      // Configuration presence only — never the values.
      aiConfigured: isAiConfigured(),
      blobConfigured: isAzureConfigured(),
    },
    version: env.releaseId,
    uptimeSeconds: Math.round(process.uptime()),
    latencyMs: Date.now() - startedAt,
  };

  return Response.json(body, {
    status: database ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
