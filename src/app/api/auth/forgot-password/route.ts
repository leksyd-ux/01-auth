import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forgotPasswordSchema } from "@/lib/validation/auth-schemas";
import { generateRandomToken, hashToken } from "@/lib/security/hash";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { sendPasswordResetEmail } from "@/lib/services/mail";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
    const body = await req.json().catch(() => ({}));

    // 1. Schema Validation
    const parseResult = forgotPasswordSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { email } = parseResult.data;

    // 2. Rate Limiting (3 attempts per 15 minutes per IP)
    const rateLimit = await checkRateLimit(`forgot:${ip}`, 3, 900);
    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many password reset requests. Please wait before trying again.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
        }
      );
    }

    // 3. User Lookup
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (user) {
      // Invalidate any previously unconsumed tokens for this user
      await prisma.passwordResetToken.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });

      // Generate single-use time-limited reset token
      const rawToken = generateRandomToken(32);
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });

      await sendPasswordResetEmail(user.email, rawToken);
    }

    // Always respond with identical message to prevent user enumeration attacks
    return NextResponse.json({
      success: true,
      message: "If that email address exists in our system, a password reset link has been dispatched.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred processing your request." },
      { status: 500 }
    );
  }
}
