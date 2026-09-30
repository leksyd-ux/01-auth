"use client";

import { useState } from "react";
import Link from "next/link";
import { forgotPasswordSchema } from "@/lib/validation/auth-schemas";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setSuccessMessage(null);
    setErrors({});

    const clientValidation = forgotPasswordSchema.safeParse({ email });
    if (!clientValidation.success) {
      setErrors(clientValidation.error.flatten().fieldErrors);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        setServerError(data.error || "Failed to process password reset request.");
        return;
      }

      setSuccessMessage(
        data.message ||
          "If an account with that email exists, password reset instructions have been sent."
      );
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
          <h1 className="auth-title">Forgot Password</h1>
          <p className="auth-subtitle">
            Enter your email to receive a secure, time-limited password reset link.
          </p>
        </header>

        {serverError && (
          <div role="alert" className="alert alert-danger" id="forgot-alert">
            {serverError}
          </div>
        )}

        {successMessage && (
          <div role="status" className="alert alert-success" id="forgot-success">
            {successMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="form-group">
            <label htmlFor="forgot-email" className="form-label">
              Email Address
            </label>
            <input
              id="forgot-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              aria-describedby={errors.email ? "email-error" : undefined}
            />
            {errors.email && (
              <span id="email-error" className="form-error">
                {errors.email[0]}
              </span>
            )}
          </div>

          <button
            id="forgot-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading ? "Sending link..." : "Send Reset Link"}
          </button>
        </form>

        <footer className="auth-footer">
          Remember your password? <Link href="/signin">Return to sign in</Link>
        </footer>
      </div>
    </main>
  );
}
