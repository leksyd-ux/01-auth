import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signupSchema } from "@/lib/validation/auth-schemas";
import { hashPassword, hashToken, generateVerificationCode } from "@/lib/security/hash";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { sendVerificationEmail } from "@/lib/services/mail";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";

    // 1. Enforce Rate Limiting (5 signups per 10 minutes per IP)
    const rateLimit = await checkRateLimit(`signup:${ip}`, 5, 600);
    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many signup attempts. Please try again later.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
        }
      );
    }

    // 2. Validate input schema
    const body = await req.json().catch(() => ({}));
    const parseResult = signupSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { name, email, password } = parseResult.data;

    // 3. Check for existing user (Idempotent handling)
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      if (existingUser.emailVerifiedAt) {
        return NextResponse.json(
          { error: "An account with this email already exists. Please sign in." },
          { status: 409 }
        );
      }

      // If user exists but is unverified, re-issue a verification code idempotently
      // Check cooldown on previous verification code
      const recentCode = await prisma.verificationCode.findFirst({
        where: { userId: existingUser.id },
        orderBy: { createdAt: "desc" },
      });

      const now = new Date();
      if (recentCode && now.getTime() - recentCode.createdAt.getTime() < 60000) {
        return NextResponse.json({
          success: true,
          message: "Verification code was recently sent. Please check your inbox.",
          email: existingUser.email,
        });
      }

      const verificationCode = generateVerificationCode();
      const codeHash = hashToken(verificationCode);
      const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins

      await prisma.verificationCode.create({
        data: {
          userId: existingUser.id,
          codeHash,
          expiresAt,
        },
      });

      await sendVerificationEmail(existingUser.email, verificationCode);

      return NextResponse.json({
        success: true,
        message: "Account already exists but unverified. A new verification code has been sent.",
        email: existingUser.email,
      });
    }

    // 4. Hash password with Argon2id
    const passwordHash = await hashPassword(password);

    // 5. Create user and verification code in a single atomic transaction
    const verificationCode = generateVerificationCode();
    const codeHash = hashToken(verificationCode);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
        },
      });

      await tx.verificationCode.create({
        data: {
          userId: user.id,
          codeHash,
          expiresAt,
        },
      });

      return user;
    });

    // 6. Dispatch verification email
    await sendVerificationEmail(newUser.email, verificationCode);

    return NextResponse.json(
      {
        success: true,
        message: "Account created successfully. Please enter the verification code sent to your email.",
        email: newUser.email,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during signup." },
      { status: 500 }
    );
  }
}
