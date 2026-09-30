import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Authentication Slice — Secure Auth System",
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
      <body>{children}</body>
    </html>
  );
}
