import { prisma } from "@/lib/prisma";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Database-backed rate limiter using fixed/sliding window counters.
 * Guarantees persistence across server restarts and multi-process deployments.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000);

  return await prisma.$transaction(async (tx) => {
    const existing = await tx.rateLimitBucket.findUnique({
      where: { key },
    });

    if (!existing || existing.expiresAt <= now) {
      // Create or reset bucket
      await tx.rateLimitBucket.upsert({
        where: { key },
        create: {
          key,
          count: 1,
          expiresAt,
        },
        update: {
          count: 1,
          expiresAt,
        },
      });

      return {
        success: true,
        remaining: maxRequests - 1,
        retryAfterSeconds: 0,
      };
    }

    if (existing.count >= maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000)
      );

      return {
        success: false,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    // Increment existing bucket
    const updated = await tx.rateLimitBucket.update({
      where: { key },
      data: {
        count: { increment: 1 },
      },
    });

    return {
      success: true,
      remaining: Math.max(0, maxRequests - updated.count),
      retryAfterSeconds: 0,
    };
  });
}
