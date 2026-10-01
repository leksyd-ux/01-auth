import { z } from "zod";

/**
 * A single name part: letters only, allowing internal apostrophes or hyphens
 * ("Anne-Marie", "O'Brien"). Unicode-aware so non-Latin names still validate.
 */
const namePart = /^[\p{L}]+(?:['’-][\p{L}]+)*$/u;

/**
 * A full name must be at least two parts ("Saul Bass" is valid, "Saul" is not),
 * and every part must be at least two letters. Blocks single-character and
 * single-word names such as "A" or "Cher" being submitted as a whole name.
 */
export const fullNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(80, "Name cannot exceed 80 characters")
  .refine(
    (value) => {
      const parts = value.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return false;
      return parts.every(
        (part) =>
          namePart.test(part) && (part.match(/\p{L}/gu)?.length ?? 0) >= 2,
      );
    },
    {
      message:
        "Enter both a first and last name, each at least 2 letters (e.g. Saul Bass)",
    },
  );

/**
 * bcrypt ignores input past 72 bytes, so a password can be valid by character
 * count yet collide with another at the byte level. This caps the byte length
 * to stay inside bcrypt's real limit.
 */
export const PASSWORD_MAX_BYTES = 72;

const byteLength = (value: string) => new TextEncoder().encode(value).length;

/**
 * The character classes a password must contain, in the order they are
 * reported. The UI shows only the FIRST unmet requirement and advances as the
 * user types, so the message stays a single actionable step instead of a wall
 * of text.
 *
 * `special` matches any non-alphanumeric character, which covers the full
 * ASCII punctuation range (,.@&!#$%^*-_=+[]{}|;:'"<>/?~\`) as well as Unicode
 * symbols, rather than a hand-listed subset that would reject valid input.
 */
const passwordRequirements = [
  { test: /[a-z]/, label: "a lowercase letter" },
  { test: /[A-Z]/, label: "an uppercase letter" },
  { test: /[0-9]/, label: "a number" },
  { test: /[^A-Za-z0-9\s]/, label: "a special character" },
] as const;

/**
 * The first character class not yet satisfied, or null when all are met.
 * Returning only the next step is what makes the message advance progressively
 * as the user types.
 */
export function firstMissingPasswordRequirement(
  password: string
): string | null {
  const unmet = passwordRequirements.find((requirement) => !requirement.test.test(password));
  return unmet ? `Password must contain ${unmet.label}.` : null;
}

/** Which requirements are still outstanding, for the live checklist UI. */
export function passwordRequirementStatus(
  password: string
): { label: string; met: boolean }[] {
  return passwordRequirements.map((requirement) => ({
    label: requirement.label,
    met: requirement.test.test(password),
  }));
}

/**
 * Validate a password and return the message for the current step.
 *
 * Precedence matters. Each character class is checked in order, so pressing the
 * first lowercase letter immediately satisfies that requirement and the message
 * advances to the next one. Length is evaluated LAST, as the final gate on the
 * finished password — a 4-character password containing every class still
 * reports the length problem, because 8-64 characters applies to the complete
 * password including everything it must contain.
 */
export function describePasswordProblem(password: string): string | null {
  // Terminal condition first: no additional character can fix this.
  if (password.length > 64) return "Password cannot exceed 64 characters.";

  // Character classes, one step at a time.
  const missing = firstMissingPasswordRequirement(password);
  if (missing) return missing;

  // Final gate on the completed password.
  if (password.length < 8) return "Password must be at least 8 characters long.";
  if (byteLength(password) > PASSWORD_MAX_BYTES) {
    return "Password is too long once non-ASCII characters are counted";
  }
  return null;
}

const passwordSchema = z
  .string()
  .max(64, "Password cannot exceed 64 characters")
  .refine((value) => byteLength(value) <= PASSWORD_MAX_BYTES, {
    message: "Password is too long once non-ASCII characters are counted",
  })
  .superRefine((value, ctx) => {
    // Character classes are checked before length, and only the next unmet step
    // is reported, so the server message matches exactly what the form shows.
    const missing = firstMissingPasswordRequirement(value);
    if (missing) {
      ctx.addIssue({ code: "custom", message: missing });
      return;
    }
    // Length is the final gate on the completed password.
    if (value.length < 8) {
      ctx.addIssue({
        code: "custom",
        message: "Password must be at least 8 characters long.",
      });
    }
  });

export const signupSchema = z.object({
  name: fullNameSchema,
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .toLowerCase()
    .email("A valid email address is required"),
  password: passwordSchema,
});

export const signinSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .toLowerCase()
    .email("A valid email address is required"),
  password: z
    .string()
    .min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .toLowerCase()
    .email("A valid email address is required"),
});

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .min(1, "Reset token is required")
    .min(16, "Reset token is invalid or malformed"),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .toLowerCase()
    .email("A valid email address is required"),
  code: z
    .string()
    .trim()
    .min(1, "Verification code is required")
    .regex(/^\d{6}$/, "Verification code must be exactly 6 digits"),
});

export const resendCodeSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .toLowerCase()
    .email("A valid email address is required"),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type SigninInput = z.infer<typeof signinSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendCodeInput = z.infer<typeof resendCodeSchema>;
