import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tessera · Secure Authentication (Slice 1)",
  description:
    "Production-minded authentication slice demonstrating Argon2id password hashing, database-backed sessions, rate limiting, and verification code lifecycle.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <div className="brand-title">
            <span className="brand-mark" aria-hidden="true">◈</span>
            <span className="brand-name">Tessera</span>
            <span className="brand-badge">Auth</span>
          </div>
        </header>

        {children}
      </body>
    </html>
  );
}
