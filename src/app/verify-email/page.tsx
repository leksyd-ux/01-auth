"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { verifyEmailSchema } from "@/lib/validation/auth-schemas";

function VerifyEmailForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialEmail = searchParams.get("email") || "";

  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  // Manage UI cooldown countdown
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setStatusMessage(null);
    setErrors({});

    const clientValidation = verifyEmailSchema.safeParse({ email, code });
    if (!clientValidation.success) {
      setErrors(clientValidation.error.flatten().fieldErrors);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.details) {
          setErrors(data.details);
        } else {
          setServerError(data.error || "Verification failed. Please verify your code.");
        }
        return;
      }

      // Verification created an authenticated session; redirect directly to minimal dashboard
      router.push("/dashboard");
      router.refresh();
    } catch {
      setServerError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!email) {
      setServerError("Please specify your email address to resend a verification code.");
      return;
    }

    setServerError(null);
    setStatusMessage(null);
    setResending(true);

    try {
      const res = await fetch("/api/auth/resend-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        setServerError(data.error || "Unable to resend code.");
        if (data.retryAfterSeconds) {
          setCooldown(data.retryAfterSeconds);
        }
        return;
      }

      setStatusMessage(data.message || "A new code has been dispatched to your email.");
      setCooldown(data.cooldownSeconds || 60);
    } catch {
      setServerError("Network error requesting code resend.");
    } finally {
      setResending(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1 className="auth-title">Verify Your Email</h1>
          <p className="auth-subtitle">
            Enter the 6-digit verification code sent to:
            <br />
            <strong>{email || "your email address"}</strong>
          </p>
        </header>

        {serverError && (
          <div role="alert" className="alert alert-danger" id="verify-alert">
            {serverError}
          </div>
        )}

        {statusMessage && (
          <div role="status" className="alert alert-success" id="verify-status">
            {statusMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {!initialEmail && (
            <div className="form-group">
              <label htmlFor="verify-email-input" className="form-label">
                Email Address
              </label>
              <input
                id="verify-email-input"
                name="email"
                type="email"
                required
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="verify-code" className="form-label">
              6-Digit Verification Code
            </label>
            <input
              id="verify-code"
              name="code"
              type="text"
              required
              maxLength={6}
              autoComplete="one-time-code"
              className="form-input verification-code-input"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              disabled={loading}
              aria-describedby={errors.code ? "code-error" : undefined}
            />
            {errors.code && (
              <span id="code-error" className="form-error">
                {errors.code[0]}
              </span>
            )}
          </div>

          <button
            id="verify-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading || code.length !== 6}
          >
            {loading ? "Verifying..." : "Verify & Continue"}
          </button>
        </form>

        <div style={{ marginTop: "24px", textAlign: "center" }}>
          <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: "12px" }}>
            Didn&apos;t receive the code?
          </p>
          <button
            id="resend-code-btn"
            type="button"
            className="btn btn-secondary"
            onClick={handleResend}
            disabled={resending || cooldown > 0}
            style={{ width: "100%" }}
          >
            {cooldown > 0
              ? `Resend available in ${cooldown}s`
              : resending
              ? "Dispatching Code..."
              : "Resend Verification Code"}
          </button>
        </div>

        <footer className="auth-footer">
          <Link href="/signin">Return to sign in</Link>
        </footer>
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="auth-page"><div className="auth-card">Loading...</div></div>}>
      <VerifyEmailForm />
    </Suspense>
  );
}
