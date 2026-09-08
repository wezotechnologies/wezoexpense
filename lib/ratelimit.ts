import "server-only";

import { ApiError } from "@/lib/rbac";

/**
 * Per-user rate limiting for the expensive routes (spec 14): /api/ai/extract
 * and /api/upload.
 *
 * Implemented as an in-process fixed-window counter. That is the right shape
 * for this app: a handful of users on a single instance, and spec 17 asks for
 * no background infrastructure beyond the one cron route — so no Redis. The
 * limiter is deliberately behind a small interface, so swapping in a shared
 * store later touches only this file.
 *
 * Trade-off worth naming: on a multi-instance deployment each instance keeps
 * its own window, so the effective ceiling is limit x instances. These limits
 * exist to stop runaway loops and accidental cost, not to defend against a
 * determined attacker who already holds valid credentials.
 */

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();
let lastSweep = Date.now();

/** Drops expired windows so the map cannot grow without bound. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const window: Window = { count: 1, resetAt: now + windowMs };
    buckets.set(key, window);
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt: window.resetAt,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/** Throws a 429 when the caller has exceeded the limit. */
export function enforceRateLimit(
  scope: string,
  userId: string,
  limit: number,
  windowMs: number,
): void {
  const result = checkRateLimit(`${scope}:${userId}`, limit, windowMs);
  if (!result.allowed) {
    throw new ApiError(
      429,
      `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
      "RATE_LIMITED",
    );
  }
}

/** Limits tuned for an occasional-use internal tool (spec 1). */
export const LIMITS = {
  upload: { limit: 30, windowMs: 60 * 60 * 1000 }, // 30 files/hour/user
  aiExtract: { limit: 20, windowMs: 60 * 60 * 1000 }, // 20 extractions/hour/user
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  report: { limit: 60, windowMs: 60 * 60 * 1000 },
} as const;
