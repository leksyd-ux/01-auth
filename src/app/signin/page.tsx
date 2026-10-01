"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signinSchema } from "@/lib/validation/auth-schemas";
import DevMailbox from "@/components/DevMailbox";
import { setPendingEmail } from "@/lib/client/flow-context";

export default function SigninPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setErrors({});

    const clientValidation = signinSchema.safeParse({ email, password });
    if (!clientValidation.success) {
      setErrors(clientValidation.error.flatten().fieldErrors);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.requiresVerification) {
          setPendingEmail(email);
          router.push("/verify-email");
          return;
        }

        if (data.details) {
          setErrors(data.details);
        } else {
          setServerError(data.error || "Sign in failed. Please verify your credentials.");
        }
        return;
      }

      // Successful sign in redirects to minimal placeholder dashboard
      router.push("/dashboard");
      router.refresh();
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
          <h1 className="auth-title">Sign In</h1>
          <p className="auth-subtitle">Welcome back. Enter your credentials to continue.</p>
        </header>

        {serverError && (
          <div role="alert" className="alert alert-danger" id="signin-alert">
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="form-group">
            <label htmlFor="signin-email" className="form-label">
              Email Address
            </label>
            <input
              id="signin-email"
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

          <div className="form-group">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label htmlFor="signin-password" className="form-label">
                Password
              </label>
              <Link href="/forgot-password" style={{ fontSize: "0.8125rem" }}>
                Forgot password?
              </Link>
            </div>
            <input
              id="signin-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              aria-describedby={errors.password ? "password-error" : undefined}
            />
            {errors.password && (
              <span id="password-error" className="form-error">
                {errors.password[0]}
              </span>
            )}
          </div>

          <button
            id="signin-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <DevMailbox address={email} />

        <footer className="auth-footer">
          Don&apos;t have an account? <Link href="/signup">Create account</Link>
        </footer>
      </div>
    </main>
  );
}
