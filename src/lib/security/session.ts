import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { generateRandomToken, hashToken } from "./hash";

export const SESSION_COOKIE_NAME = "auth_session";
export const SESSION_EXPIRY_DAYS = 7;
export const SESSION_EXPIRY_SECONDS = SESSION_EXPIRY_DAYS * 24 * 60 * 60;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerifiedAt: Date | null;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
}

/**
 * Creates a new server-side session in the database and sets the HttpOnly cookie.
 */
export async function createSession(userId: string): Promise<string> {
  const rawToken = generateRandomToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_SECONDS * 1000);

  // Store hashed session in database
  await prisma.session.create({
    data: {
      userId,
      sessionTokenHash: tokenHash,
      expiresAt,
    },
  });

  // Attach HttpOnly cookie
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_EXPIRY_SECONDS,
  });

  return rawToken;
}

/**
 * Retrieves and validates the active session from the database.
 * If expired or invalid, returns null.
 */
export async function getCurrentSession(): Promise<ActiveSession | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const session = await prisma.session.findUnique({
    where: { sessionTokenHash: tokenHash },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          emailVerifiedAt: true,
        },
      },
    },
  });

  if (!session) {
    return null;
  }

  // Enforce server-side expiration
  if (session.expiresAt <= now) {
    // Clean up expired session from DB
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  return {
    sessionId: session.id,
    user: session.user,
    expiresAt: session.expiresAt,
  };
}

/**
 * Terminates the session by deleting it from the database and clearing the cookie.
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    await prisma.session
      .deleteMany({
        where: { sessionTokenHash: tokenHash },
      })
      .catch(() => {});
  }

  // Clear cookie
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
