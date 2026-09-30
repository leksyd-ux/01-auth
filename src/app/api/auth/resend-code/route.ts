import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resendCodeSchema } from "@/lib/validation/auth-schemas";
import { generateVerificationCode, hashToken } from "@/lib/security/hash";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { sendVerificationEmail } from "@/lib/services/mail";

const RESEND_COOLDOWN_SECONDS = 60;

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
    const body = await req.json().catch(() => ({}));

    // 1. Schema Validation
    const parseResult = resendCodeSchema.safeParse(body);
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

    // 2. Global Rate Limit (3 resends per 15 minutes per IP/email)
    const rateLimit = await checkRateLimit(`resend:${ip}:${email}`, 3, 900);
    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many resend attempts. Please wait before requesting another code.",
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

    if (!user) {
      // Return generic success to avoid email enumeration
      return NextResponse.json({
        success: true,
        message: "If that account exists, a new verification code has been dispatched.",
      });
    }

    if (user.emailVerifiedAt) {
      return NextResponse.json(
        { error: "Account email is already verified. Please sign in." },
        { status: 400 }
      );
    }

    // 4. Server-Enforced Cooldown Check (Database-backed)
    const latestCode = await prisma.verificationCode.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    const now = new Date();
    if (latestCode) {
      const elapsedSeconds = Math.floor((now.getTime() - latestCode.createdAt.getTime()) / 1000);
      if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
        const remainingCooldown = RESEND_COOLDOWN_SECONDS - elapsedSeconds;
        return NextResponse.json(
          {
            error: `Please wait ${remainingCooldown}s before requesting a new verification code.`,
            retryAfterSeconds: remainingCooldown,
          },
          {
            status: 429,
            headers: { "Retry-After": remainingCooldown.toString() },
          }
        );
      }
    }

    // 5. Generate and store new code
    const newCode = generateVerificationCode();
    const codeHash = hashToken(newCode);
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

    await prisma.verificationCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt,
      },
    });

    // 6. Dispatch email
    await sendVerificationEmail(user.email, newCode);

    return NextResponse.json({
      success: true,
      message: "A new verification code has been dispatched to your email.",
      cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    console.error("Resend code error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred while resending the code." },
      { status: 500 }
    );
  }
}
