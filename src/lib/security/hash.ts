import * as argon2 from "argon2";
import crypto from "crypto";

/**
 * Hash a plaintext password using Argon2id with memory-hard parameters.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB memory
    timeCost: 3,       // 3 iterations
    parallelism: 4,    // 4 parallel threads
  });
}

/**
 * Verify a plaintext candidate password against an Argon2 hash.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Deterministically hash an opaque token (session token, reset token, verification code)
 * using SHA-256 before storing it in the database.
 * This ensures that a database compromise does not leak actionable bearer tokens.
 */
export function hashToken(token: string): string {
  const secret = process.env.AUTH_SECRET || "default-auth-secret-salt-32-chars";
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

/**
 * Generate a cryptographically secure random opaque token.
 */
export function generateRandomToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Generate a cryptographically secure 6-digit numeric verification code.
 */
export function generateVerificationCode(): string {
  // Generates integer in range [100000, 999999]
  const min = 100000;
  const max = 999999;
  return crypto.randomInt(min, max + 1).toString();
}
