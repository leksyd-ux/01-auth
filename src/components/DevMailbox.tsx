"use client";

import { useEffect, useState } from "react";

interface OutboxEmail {
  id: string;
  to: string;
  subject: string;
  type: "verification_code" | "password_reset";
  codeOrToken: string;
  link?: string;
  sentAt: string;
}

/**
 * Development-only mailbox viewer.
 *
 * There is no real email transport in this slice, so codes and reset links are
 * written to the dev outbox (src/lib/services/mail.ts) and the server console.
 * Without this panel the verification flow cannot be completed from a browser.
 *
 * The endpoint it reads returns 404 in production, so this component renders
 * nothing there.
 */
export default function DevMailbox({ address }: { address: string }) {
  const [emails, setEmails] = useState<OutboxEmail[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!address) return;

    let cancelled = false;
    const target = address.toLowerCase();

    async function load() {
      try {
        const res = await fetch("/api/dev/outbox", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const mine = (data.emails ?? []).filter(
          (e: OutboxEmail) => e.to.toLowerCase() === target
        );
        setEmails(mine);
      } catch {
        // Dev-only affordance; failure here must never block the real flow.
      }
    }

    load();
    const poll = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [address]);

  if (!address) return null;

  if (emails.length === 0) {
    return (
      <section className="dev-mailbox" aria-label="Development mailbox">
        <p className="dev-mailbox-empty">
          No development message captured for this address yet.
        </p>
      </section>
    );
  }

  return (
    <section className="dev-mailbox" aria-label="Development mailbox">
      <button
        type="button"
        className="dev-mailbox-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="dev-mailbox-badge">DEV ONLY</span>
        <span>
          Development mailbox &mdash; no real email is sent
          {emails.length > 1 ? ` (${emails.length} messages)` : ""}
        </span>
        <span className="dev-mailbox-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <ul className="dev-mailbox-list">
          {emails.map((e) => (
            <li key={e.id} className="dev-mailbox-item">
              <p className="dev-mailbox-meta">
                to {e.to} &middot; {e.type.replace("_", " ")}
              </p>
              <p className="dev-mailbox-subject">{e.subject}</p>
              {e.type === "verification_code" && (
                <p className="dev-mailbox-code">{e.codeOrToken}</p>
              )}
              {e.link && (
                <a href={e.link} className="dev-mailbox-link">
                  {e.link}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
