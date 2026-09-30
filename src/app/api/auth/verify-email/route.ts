import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyEmailSchema } from "@/lib/validation/auth-schemas";
import { hashToken } from "@/lib/security/hash";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { createSession } from "@/lib/security/session";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
    const body = await req.json().catch(() => ({}));

    // 1. Schema Validation
    const parseResult = verifyEmailSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { email, code } = parseResult.data;

    // 2. Rate Limiting (5 attempts per 10 minutes)
    const rateLimit = await checkRateLimit(`verify:${ip}:${email}`, 5, 600);
    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many verification attempts. Please try again later.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
        }
      );
    }

    // 3. Find user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Invalid or expired verification code." },
        { status: 400 }
      );
    }

    if (user.emailVerifiedAt) {
      // Already verified, create session and proceed
      await createSession(user.id);
      return NextResponse.json({
        success: true,
        message: "Email is already verified.",
      });
    }

    // 4. Find valid active verification code
    const now = new Date();
    const candidateHash = hashToken(code);

    const validRecord = await prisma.verificationCode.findFirst({
      where: {
        userId: user.id,
        codeHash: candidateHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
    });

    if (!validRecord) {
      return NextResponse.json(
        { error: "Invalid or expired verification code." },
        { status: 400 }
      );
    }

    // 5. Invalidate verification code and verify user atomically
    await prisma.$transaction([
      prisma.verificationCode.update({
        where: { id: validRecord.id },
        data: { usedAt: now },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: now },
      }),
    ]);

    // 6. Establish session to allow direct access to dashboard
    await createSession(user.id);

    return NextResponse.json({
      success: true,
      message: "Email successfully verified. Welcome!",
    });
  } catch (error) {
    console.error("Verification error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during verification." },
      { status: 500 }
    );
  }
}
