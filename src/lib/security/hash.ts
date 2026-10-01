import bcrypt from "bcrypt";
import crypto from "crypto";

/**
 * bcrypt work factor. Each increment doubles the CPU cost, so this is the
 * single most important security knob in this file.
 */
const BCRYPT_COST = 10;

/** Prefix identifying a hash produced by bcrypt, used to route verification. */
const BCRYPT_PREFIX = "$2";

/**
 * Hash a plaintext password using bcrypt.
 *
 * bcrypt generates a unique random salt per call and embeds both the salt and
 * the cost factor in the returned string, so the hash is self-describing and
 * never needs a separate salt column.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Verify a plaintext candidate password against a stored hash.
 *
 * Supports both bcrypt ($2...) and legacy Argon2id ($argon2id$) hashes so that
 * accounts created before the bcrypt migration can still sign in. When a
 * legacy Argon2id hash verifies, the caller should re-hash with bcrypt to
 * upgrade the stored credential — see needsRehash.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    if (isBcryptHash(hash)) {
      return await bcrypt.compare(plain, hash);
    }

    if (isArgon2Hash(hash)) {
      // Lazy import so the Argon2 native module is only loaded if a legacy
      // hash is actually encountered.
      const argon2 = await import("argon2");
      return await argon2.verify(hash, plain);
    }

    return false;
  } catch {
    return false;
  }
}

export function isBcryptHash(hash: string): boolean {
  return hash.startsWith(BCRYPT_PREFIX);
}

export function isArgon2Hash(hash: string): boolean {
  return hash.startsWith("$argon2");
}

/**
 * True when a hash was produced with a weaker setting than current policy, so
 * the caller can transparently upgrade it on the next successful sign-in.
 */
export async function needsRehash(hash: string): Promise<boolean> {
  if (!isBcryptHash(hash)) return true;
  try {
    const cost = Number(hash.split("$")[2]);
    return cost < BCRYPT_COST;
  } catch {
    return true;
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
