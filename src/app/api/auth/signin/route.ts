import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signinSchema } from "@/lib/validation/auth-schemas";
import { verifyPassword } from "@/lib/security/hash";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { createSession } from "@/lib/security/session";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";
    const body = await req.json().catch(() => ({}));

    // 1. Validate input schema
    const parseResult = signinSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    const { email, password } = parseResult.data;

    // 2. Enforce Rate Limiting (5 attempts per 15 minutes per IP + email)
    const rateLimitKey = `signin:${ip}:${email}`;
    const rateLimit = await checkRateLimit(rateLimitKey, 5, 900);
    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many signin attempts. Please try again later.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
        }
      );
    }

    // 3. Retrieve user
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Use constant-time comparison dummy check or generic response to avoid enumeration
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    // 4. Verify password with Argon2
    const passwordMatch = await verifyPassword(user.passwordHash, password);
    if (!passwordMatch) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      );
    }

    // 5. Check if email is verified
    if (!user.emailVerifiedAt) {
      return NextResponse.json(
        {
          error: "Please verify your email address before signing in.",
          requiresVerification: true,
          email: user.email,
        },
        { status: 403 }
      );
    }

    // 6. Create session and set HttpOnly cookie
    await createSession(user.id);

    return NextResponse.json({
      success: true,
      message: "Sign in successful.",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Signin error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during signin." },
      { status: 500 }
    );
  }
}
