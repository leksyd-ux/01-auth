"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  signupSchema,
  describePasswordProblem,
  passwordRequirementStatus,
} from "@/lib/validation/auth-schemas";
import { setPendingEmail } from "@/lib/client/flow-context";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Field is invalid only once it has been touched or a submit was attempted,
  // so a pristine form never paints itself red. The valid state is gated the
  // same way in the other direction — a field that was never touched is left
  // neutral rather than congratulating the user for doing nothing.
  const isEngaged = (field: "name" | "email" | "password") =>
    touched[field] || submitAttempted;

  const isInvalid = (field: "name" | "email" | "password", ok: boolean) =>
    !ok && isEngaged(field);

  const isValid = (field: "name" | "email" | "password", ok: boolean) =>
    ok && isEngaged(field);

  // aria-invalid carries three states: "true" (red), "false" (green), and
  // undefined (neutral, untouched). All styling keys off these attributes.
  const fieldState = (field: "name" | "email" | "password", ok: boolean) =>
    isInvalid(field, ok) ? true : isValid(field, ok) ? false : undefined;

  const nameResult = signupSchema.shape.name.safeParse(name);
  const emailResult = signupSchema.shape.email.safeParse(email);
  const passwordResult = signupSchema.shape.password.safeParse(password);

  // Prefer a server-supplied message; fall back to the local schema's message.
  const pick = (
    field: "name" | "email" | "password",
    result: { success: true } | { success: false; error: { issues: { message: string }[] } }
  ) => {
    const live = result.success ? null : result.error.issues[0].message;
    return errors[field]?.[0] ?? live;
  };

  const nameError = isInvalid("name", nameResult.success) ? pick("name", nameResult) : null;
  const emailError = isInvalid("email", emailResult.success) ? pick("email", emailResult) : null;
  // The password message names only the next unmet step, and advances on every
  // keystroke. The checklist below it shows all four at once so the user can
  // see what is still outstanding — but both are scaffolding, so once the
  // password is complete and valid, neither is rendered. That keeps the form
  // clean instead of leaving four satisfied tick marks on screen.
  const requirementStatus = passwordRequirementStatus(password);
  const passwordComplete = passwordResult.success;
  // Scaffolding appears only once the field has been engaged, and disappears
  // entirely the moment the password is valid — so a pristine form shows
  // nothing, and a completed password leaves no text under the field.
  const passwordEngaged = touched.password || submitAttempted || password.length > 0;
  const showPasswordHints = passwordEngaged && !passwordComplete;
  const passwordError =
    isInvalid("password", passwordComplete) && !passwordComplete
      ? (errors.password?.[0] ?? describePasswordProblem(password))
      : null;

  // The submit button stays disabled until every field satisfies its rule, so
  // an incomplete form cannot be sent. This mirrors the client-side mirror in
  // handleSubmit — the server still revalidates, since a disabled button is a
  // UI affordance and not a security control.
  const formValid =
    nameResult.success && emailResult.success && passwordResult.success;

  // Named so the disabled button can explain itself instead of being an inert
  // grey rectangle. Naming the missing fields is the whole point: a disabled
  // control that does not say why is a dead end.
  //
  // The hint is scaffolding too, so it follows the same engagement rule as the
  // password checklist: absent on a pristine form, present once the user has
  // started, and gone again the moment the form becomes valid. A permanent
  // "Still needed: ..." banner on an untouched page is just as bulky as the
  // checklist it was meant to replace, and it front-loads the page with
  // instructions before anyone has done anything.
  const formEngaged =
    touched.name ||
    touched.email ||
    touched.password ||
    submitAttempted ||
    name.length > 0 ||
    email.length > 0 ||
    password.length > 0;

  const showSubmitHint = formEngaged && !formValid;

  const missingFields = [
    !nameResult.success && "your full name",
    !emailResult.success && "a valid email",
    !passwordResult.success && "a password meeting the requirements",
  ].filter(Boolean) as string[];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setSubmitAttempted(true);
    setErrors({});

    // Client-side validation mirror
    const clientValidation = signupSchema.safeParse({ name, email, password });
    if (!clientValidation.success) {
      setErrors(clientValidation.error.flatten().fieldErrors);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.details) {
          setErrors(data.details);
        } else {
          setServerError(data.error || "An error occurred during account creation.");
        }
        return;
      }

      // Carry the email in sessionStorage, not the query string, so it never
      // reaches the access log, browser history, or a Referer header.
      setPendingEmail(email);
      router.push("/verify-email");
    } catch {
      setServerError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1 className="auth-title">Create Account</h1>
          <p className="auth-subtitle">Sign up for access to your personal workspace</p>
        </header>

        {serverError && (
          <div role="alert" className="alert alert-danger" id="signup-alert">
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="form-group">
            <label htmlFor="signup-name" className="form-label">
              Full Name
            </label>
            <input
              id="signup-name"
              name="name"
              type="text"
              required
              minLength={5}
              autoComplete="name"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              disabled={loading}
              aria-invalid={fieldState("name", nameResult.success)}
              aria-describedby={nameError ? "name-error" : undefined}
            />
            {nameError && (
              <span id="name-error" className="form-error" role="alert">
                {nameError}
              </span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="signup-email" className="form-label">
              Email Address
            </label>
            <input
              id="signup-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              disabled={loading}
              aria-invalid={fieldState("email", emailResult.success)}
              aria-describedby={emailError ? "email-error" : undefined}
            />
            {emailError && (
              <span id="email-error" className="form-error" role="alert">
                {emailError}
              </span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="signup-password" className="form-label">
              Password
            </label>
            <input
              id="signup-password"
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={64}
              autoComplete="new-password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              disabled={loading}
              aria-invalid={fieldState("password", passwordComplete)}
              aria-describedby={passwordError ? "password-error" : undefined}
            />
            {passwordError && (
              <span id="password-error" className="form-error" role="alert">
                {passwordError}
              </span>
            )}
            {showPasswordHints && (
              <ul className="password-requirements" aria-label="Password requirements">
                {/* Character classes first, matching the order the message asks
                    for them. Length is listed last because it applies to the
                    finished password. */}
                {requirementStatus.map((requirement) => (
                  <li key={requirement.label} className={requirement.met ? "met" : ""}>
                    <span aria-hidden="true">{requirement.met ? "✓" : "•"}</span> At least{" "}
                    {requirement.label}
                  </li>
                ))}
                <li className={password.length >= 8 ? "met" : ""}>
                  <span aria-hidden="true">{password.length >= 8 ? "✓" : "•"}</span> Between
                  8 and 64 characters
                </li>
              </ul>
            )}
          </div>

          <button
            id="signup-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading || !formValid}
            aria-describedby={showSubmitHint ? "signup-submit-hint" : undefined}
          >
            {loading ? "Creating Account..." : "Create Account"}
          </button>
          {showSubmitHint && (
            <p id="signup-submit-hint" className="submit-hint">
              Still needed: {missingFields.join(", ")}.
            </p>
          )}
        </form>

        <footer className="auth-footer">
          Already have an account? <Link href="/signin">Sign in</Link>
        </footer>
      </div>
    </main>
  );
}
