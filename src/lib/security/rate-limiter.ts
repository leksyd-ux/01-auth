import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Database-backed fixed-window rate limiter.
 *
 * Persistence across restarts and across multiple processes is deliberate: an
 * in-memory Map resets on deploy and is per-process, so it enforces nothing in a
 * serverless or multi-worker deployment.
 *
 * The whole check is ONE atomic statement. This matters more than it looks:
 *
 *  - A read-then-write (`findUnique` then `update`) is not safe. Concurrent
 *    requests all read the same `count` and then overwrite each other, so a
 *    limit of 5 can admit 10, 20, or more. Measured before this fix: 13 of 30
 *    simultaneous sign-ins were admitted.
 *  - Upserting "create if missing" is not safe either. When the bucket does not
 *    exist yet, every concurrent request takes the create branch, each sets
 *    `count = 1`, and each returns success. The counter then under-reports how
 *    many requests actually arrived.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` is a single statement, so Postgres
 * serialises it. The `WHERE` on the `DO UPDATE` is the guard: the update only
 * proceeds when the window has expired (reset to 1) or the counter is still
 * below the limit. When neither holds, no row is returned and the caller is
 * rate limited. `RETURNING count` gives the post-update value for the
 * `remaining` calculation without a second round trip.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000);

  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO rate_limit_buckets ("id", "key", "count", "expiresAt", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${expiresAt}, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE
      SET "count" = CASE
            WHEN rate_limit_buckets."expiresAt" <= ${now} THEN 1
            ELSE rate_limit_buckets."count" + 1
          END,
          "expiresAt" = CASE
            WHEN rate_limit_buckets."expiresAt" <= ${now} THEN ${expiresAt}
            ELSE rate_limit_buckets."expiresAt"
          END,
          "updatedAt" = ${now}
    WHERE rate_limit_buckets."expiresAt" <= ${now}
       OR rate_limit_buckets."count" < ${maxRequests}
    RETURNING "count"
  `);

  if (rows.length > 0) {
    return {
      success: true,
      remaining: Math.max(0, maxRequests - rows[0].count),
      retryAfterSeconds: 0,
    };
  }

  // Guard rejected the update: the window is live and the counter is at the cap.
  const current = await prisma.rateLimitBucket.findUnique({ where: { key } });
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((current?.expiresAt ?? expiresAt).getTime() - now.getTime()) / 1000)
  );

  return {
    success: false,
    remaining: 0,
    retryAfterSeconds,
  };
}
