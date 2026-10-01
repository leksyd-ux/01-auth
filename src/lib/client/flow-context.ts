/**
 * Carries values between auth pages without putting them in the URL.
 *
 * A query string is the wrong place for an email address or a reset token.
 * Anything in the URL leaks somewhere the user cannot see or control:
 *
 *   - the server access log, as part of the request line
 *   - the browser history, where it survives for anyone with the device
 *   - the Referer header sent to every third-party resource on the page
 *   - any analytics or error-reporting script embedded on the page
 *
 * sessionStorage is per-tab and cleared when the tab closes, which matches how
 * these flows actually work: the email is only needed between "account
 * created" and "code entered" in the same tab, and the reset token is
 * consumed the moment the link is opened.
 *
 * This is exposed through `useSyncExternalStore` rather than a `useState` +
 * `useEffect` pair. Reading storage after mount is inherently a post-hydration
 * concern, and the effect-plus-setState shape triggers a cascading render on
 * every mount; `useSyncExternalStore` models it as what it is — a store — and
 * gives a clean server snapshot so SSR and the first client render agree.
 */

import { useSyncExternalStore } from "react";

const PENDING_EMAIL_KEY = "auth:pending-email";
const RESET_TOKEN_KEY = "auth:reset-token";

type Listener = () => void;

const listeners = new Set<Listener>();

// Cached snapshots. useSyncExternalStore compares snapshots with Object.is, so
// returning a fresh value on every call would re-render forever.
let pendingEmailSnapshot: string = "";
let resetTokenSnapshot: string = "";

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Storage throws in private-mode Safari and when a browser blocks site data.
// These flows must degrade to "value unavailable", never to a white screen.
function readRaw(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Non-fatal: the user can still type their email on the verify page.
  }
}

function removeRaw(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Non-fatal.
  }
}

/** True on the client after hydration, false during SSR and the first paint. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

/** The email handed over by the signup or signin step, or "" if none. */
export function usePendingEmail(): string {
  return useSyncExternalStore(subscribe, getPendingEmail, () => "");
}

function getPendingEmail(): string {
  if (typeof window === "undefined") return pendingEmailSnapshot;
  const stored = readRaw(PENDING_EMAIL_KEY);
  if (stored !== pendingEmailSnapshot) {
    pendingEmailSnapshot = stored;
  }
  return pendingEmailSnapshot;
}

/** The reset token, moved out of the URL fragment into storage on arrival. */
export function useResetToken(): string {
  return useSyncExternalStore(subscribe, getResetToken, () => "");
}

function getResetToken(): string {
  if (typeof window === "undefined") return resetTokenSnapshot;
  const stored = readRaw(RESET_TOKEN_KEY);
  if (stored !== resetTokenSnapshot) {
    resetTokenSnapshot = stored;
  }
  return resetTokenSnapshot;
}

export function setPendingEmail(email: string): void {
  if (!email) return;
  writeRaw(PENDING_EMAIL_KEY, email);
  pendingEmailSnapshot = email;
  emit();
}

export function clearPendingEmail(): void {
  removeRaw(PENDING_EMAIL_KEY);
  pendingEmailSnapshot = "";
  emit();
}

export function setResetToken(token: string): void {
  if (!token) return;
  writeRaw(RESET_TOKEN_KEY, token);
  resetTokenSnapshot = token;
  emit();
}

export function clearResetToken(): void {
  removeRaw(RESET_TOKEN_KEY);
  resetTokenSnapshot = "";
  emit();
}

/**
 * Moves a token out of `location.hash` into sessionStorage and scrubs the
 * address bar. Called once on mount by the reset page.
 *
 * `replaceState` rather than `pushState`: the history entry that carried the
 * token is overwritten, so it is not recoverable with the back button either.
 */
export function consumeTokenFromHash(): void {
  if (typeof window === "undefined") return;

  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get(
    "token"
  );

  if (!fromHash) return;

  setResetToken(fromHash);
  window.history.replaceState(null, "", window.location.pathname);
}