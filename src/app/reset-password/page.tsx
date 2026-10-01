"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  resetPasswordSchema,
  describePasswordProblem,
} from "@/lib/validation/auth-schemas";
import {
  useResetToken,
  useHydrated,
  consumeTokenFromHash,
  clearResetToken,
} from "@/lib/client/flow-context";

function ResetPasswordForm() {
  // The token arrives in the URL fragment, which the browser never sends to the
  // server. On arrival it is moved into sessionStorage and the address bar is
  // rewritten, so the token survives neither the access log, nor the Referer
  // header, nor the back button — and the user sees a clean /reset-password URL
  // like every other page.
  const token = useResetToken();
  const hydrated = useHydrated();

  useEffect(() => {
    consumeTokenFromHash();
  }, []);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  // Names only the character classes still missing, recomputed as the user types.
  const passwordProblem = errors.password?.[0] ?? describePasswordProblem(password);

  if (hydrated && !token) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <header className="auth-header">
            <h1 className="auth-title">Invalid Reset Link</h1>
            <p className="auth-subtitle">No reset token was provided in the link.</p>
          </header>
          <div role="alert" className="alert alert-danger">
            Please use the link sent to your email address or request a new reset link.
          </div>
          <footer className="auth-footer">
            <Link href="/forgot-password">Request New Reset Link</Link>
          </footer>
        </div>
      </main>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setErrors({});

    if (password !== confirmPassword) {
      setErrors({ confirmPassword: ["Passwords do not match"] });
      return;
    }

    const clientValidation = resetPasswordSchema.safeParse({ token, password });
    if (!clientValidation.success) {
      setErrors(clientValidation.error.flatten().fieldErrors);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.details) {
          setErrors(data.details);
        } else {
          setServerError(data.error || "Password reset failed.");
        }
        return;
      }

      // Single-use token is now spent; drop it so a reload cannot replay it.
      clearResetToken();
      setSuccess(true);
    } catch {
      setServerError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <header className="auth-header">
            <h1 className="auth-title">Password Reset Complete</h1>
            <p className="auth-subtitle">Your password has been successfully updated.</p>
          </header>
          <div role="status" className="alert alert-success">
            You can now sign in with your new password. All prior sessions have been invalidated.
          </div>
          <Link href="/signin" className="btn btn-primary" style={{ width: "100%" }}>
            Go to Sign In
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1 className="auth-title">Set New Password</h1>
          <p className="auth-subtitle">Enter your new secure password below.</p>
        </header>

        {serverError && (
          <div role="alert" className="alert alert-danger" id="reset-alert">
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="form-group">
            <label htmlFor="reset-new-password" className="form-label">
              New Password
            </label>
            <input
              id="reset-new-password"
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={64}
              autoComplete="new-password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              aria-invalid={passwordProblem ? true : undefined}
              aria-describedby={passwordProblem ? "password-error" : undefined}
            />
            {passwordProblem && (
              <span id="password-error" className="form-error" role="alert">
                {passwordProblem}
              </span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="reset-confirm-password" className="form-label">
              Confirm New Password
            </label>
            <input
              id="reset-confirm-password"
              name="confirmPassword"
              type="password"
              required
              autoComplete="new-password"
              className="form-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={loading}
              aria-describedby={errors.confirmPassword ? "confirm-error" : undefined}
            />
            {errors.confirmPassword && (
              <span id="confirm-error" className="form-error">
                {errors.confirmPassword[0]}
              </span>
            )}
          </div>

          <button
            id="reset-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading ? "Resetting Password..." : "Update Password"}
          </button>
        </form>

        <footer className="auth-footer">
          <Link href="/signin">Cancel and return to sign in</Link>
        </footer>
      </div>
    </main>
  );
}

// No Suspense boundary needed: the token now comes from the fragment and
// sessionStorage in an effect, not from search params.
export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
