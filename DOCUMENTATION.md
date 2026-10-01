# DOCUMENTATION — Assessment 1: Authentication Slice

---

## Section 1 — What This Is

This project is a production-minded authentication slice built with Next.js (App Router), TypeScript, Prisma ORM, and PostgreSQL. It delivers a complete, secure identity flow consisting of account creation, server-enforced email verification with cooldown timers, credential authentication, single-use password resets, and database-backed session management that terminates at a minimal placeholder dashboard. All security invariants—including adaptive password hashing with bcrypt, sliding-window rate limiting, input schema validation, and session lifecycle controls—are strictly validated and enforced on the server and database tiers.

All non-essential product functionality is deliberately excluded. This slice includes no marketing pages, no landing pages, no social login, no two-factor authentication, no profile settings, and no dashboard features beyond presenting the authenticated user's name alongside a sign-out button. This discipline guarantees that the codebase remains focused entirely on identity integrity, attack resistance, and verifiable engineering patterns without decorative distractions.

---

## Section 2 — How To Run It

Follow these numbered steps to run the application locally from a fresh clone:

1. **Prerequisites**: Ensure Node.js (v18+) and PostgreSQL are installed and running locally.
2. **Install Dependencies**:
   ```bash
   cd 01-auth
   npm install
   ```
3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Configure each variable in `.env`:
   - `DATABASE_URL`: PostgreSQL connection string (e.g., `postgresql://<user>@localhost:5432/assessment_auth?schema=public`). Sourced from your local PostgreSQL service.
   - `NEXT_PUBLIC_APP_URL`: Base application URL (`http://localhost:3000`). Used to construct absolute password reset links.
   - `AUTH_SECRET`: Random 32+ character hex string used to salt opaque token hashes in HMAC calculations.
   - `NODE_ENV`: Application environment (`development` or `production`).
4. **Create Database**:
   ```bash
   psql -d postgres -c "CREATE DATABASE assessment_auth;"
   ```
5. **Run Database Migrations**:
   ```bash
   npx prisma migrate dev
   ```
6. **Start Application**:
   ```bash
   npm run dev
   ```
7. **Access Local Instance**:
   Open [http://localhost:3000](http://localhost:3000) in your browser. Unauthenticated visits automatically redirect to `/signin`.

   **No real email is sent in development.** Verification codes and password reset links are written to the server console and an in-memory outbox. The sign-in, sign-up, verify-email, and forgot-password pages show a `DEV ONLY` mailbox panel with the current address's latest code and reset link, so the flow can be completed by clicking. In production that panel renders nothing, because `/api/dev/outbox` returns `404` when `NODE_ENV === "production"`.
8. **Run Verification Test Suite**:
   With the dev server running, in a second terminal:
   ```bash
   chmod +x test-auth-flow.sh
   ./test-auth-flow.sh
   ```
   This exercises the full flow plus the adversarial cases: validation bypass, idempotent signup, expired/replayed codes, resend cooldown, reset-token reuse, forged cookies, concurrent signup, 30 concurrent sign-ins against the rate limit, and the account-takeover attempt described in Section 6 Problem 1. It cleans up its own test users.

---

## Section 3 — The Flow, Step By Step

### Flow 1: Account Creation & Email Verification
1. **User Action**: The user visits `/signup`, completes their Name, Email, and Password, and clicks "Create Account".
2. **Frontend Transmission**: `SignupPage` (`src/app/signup/page.tsx`) mirrors validation using `signupSchema` and sends a `POST` request with JSON `{ name, email, password }` to `/api/auth/signup`.
3. **Server Processing**:
   - The route handler `/api/auth/signup/route.ts` verifies client IP rate limits (`checkRateLimit('signup:ip', 5, 600)`).
   - Validates input via Zod `signupSchema`.
   - Checks if an account exists: if existing and unverified, it idempotently refreshes the verification code; if existing and verified, returns `409 Conflict`.
   - Hashes password using bcrypt at cost 10 (`hashPassword`).
   - Generates a 6-digit random code, hashes it with HMAC-SHA256, and stores it in `verification_codes` with a 15-minute expiration.
   - Dispatches the code to the development outbox (`src/lib/services/mail.ts`) and console.
   - Returns `201 Created`. The browser redirects to a bare `/verify-email` — the email is carried in `sessionStorage`, never in the URL, so it cannot reach the access log, browser history, or a Referer header.
3. **User Action**: The user checks the development mailbox panel on the page (or the server console), inputs the 6-digit code on `/verify-email`, and clicks "Verify & Continue".
4. **Frontend Transmission**: `VerifyEmailPage` (`src/app/verify-email/page.tsx`) sends `{ email, code }` via `POST` to `/api/auth/verify-email`.
5. **Server Processing**:
    - `/api/auth/verify-email/route.ts` verifies rate limits and validates schema.
    - If the account is **already verified**, it returns a neutral `alreadyVerified` response and deliberately does *not* create a session — see Section 5, "Verification Is Not an Authentication Path".
    - Otherwise computes HMAC-SHA256 of the candidate code and finds the active unexpired, unused record in `verification_codes`.
    - In an atomic transaction, marks `usedAt = now` on the code and sets `emailVerifiedAt = now` on the user.
    - Invokes `createSession(user.id)` in `src/lib/security/session.ts`, storing the hashed session in the `sessions` table and attaching an `HttpOnly`, `SameSite=Lax` cookie.
    - Redirects the user to `/dashboard`.

### Flow 2: Returning User Sign In
1. **User Action**: User visits `/signin`, enters email and password, and submits.
2. **Frontend Transmission**: `SigninPage` (`src/app/signin/page.tsx`) sends `POST` with credentials to `/api/auth/signin`.
3. **Server Processing**:
   - `/api/auth/signin/route.ts` checks sliding rate limit (`5 attempts / 15 minutes` per IP + email).
   - Queries `users` table for email.
   - Verifies candidate password against the stored bcrypt hash using `verifyPassword`, which also accepts legacy Argon2id hashes and upgrades them in place on success.
   - Verifies `emailVerifiedAt` is not null. (If null, returns `403` with `{ requiresVerification: true }`, prompting redirect to `/verify-email`).
   - Calls `createSession(user.id)`, issuing session cookie.
   - Returns `200 OK`. User reaches `/dashboard`.

### Flow 3: Forgotten Password & Reset
1. **User Action**: User visits `/forgot-password`, provides email, and submits.
2. **Frontend Transmission**: `ForgotPasswordPage` (`src/app/forgot-password/page.tsx`) sends `POST` to `/api/auth/forgot-password`.
3. **Server Processing**:
   - `/api/auth/forgot-password/route.ts` rate limits by IP (3 requests / 15 mins).
   - Looks up user. If found, invalidates prior unused reset tokens and creates a new cryptographic 32-byte token.
   - Hashes token into `password_reset_tokens` with 15-minute expiration.
   - Dispatches reset link `${NEXT_PUBLIC_APP_URL}/reset-password#token=<rawToken>`. The token rides in the URL **fragment**, which browsers never send to the server, and the page moves it into `sessionStorage` and rewrites the address bar on arrival — so it appears in no access log, no Referer header, and no history entry.
   - Always returns uniform success response to prevent email enumeration.
4. **User Action**: User navigates to the reset URL, types a new password matching policy, and submits.
5. **Frontend Transmission**: `ResetPasswordPage` (`src/app/reset-password/page.tsx`) sends `{ token, password }` via `POST` to `/api/auth/reset-password`.
6. **Server Processing**:
   - `/api/auth/reset-password/route.ts` hashes token and queries `password_reset_tokens` for an unexpired, unused record.
   - Hashes new password with bcrypt at cost 10.
   - In an atomic transaction: marks token `usedAt = now`, updates user `passwordHash`, and purges all active records from `sessions` table for that user.
   - Returns `200 OK`. User signs in with new credentials.

### Flow 4: Session Invalidation (Sign Out)
1. **User Action**: User clicks "Sign Out" button on `/dashboard`.
2. **Frontend Transmission**: `SignoutButton` (`src/components/SignoutButton.tsx`) sends `POST` to `/api/auth/signout`.
3. **Server Processing**:
   - `/api/auth/signout/route.ts` calls `destroySession()` (`src/lib/security/session.ts`).
   - Deletes session row from `sessions` table matching cookie token hash.
   - Sets response cookie `auth_session` with `Max-Age=0` and past expiry.
   - Returns `200 OK`. Client redirects to `/signin`.

---

## Section 4 — The Data Model

```prisma
model User {
  id              String                @id @default(uuid())
  email           String                @unique
  name            String
  passwordHash    String
  emailVerifiedAt DateTime?
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt

  verificationCodes   VerificationCode[]
  passwordResetTokens PasswordResetToken[]
  sessions            Session[]

  @@map("users")
}

model VerificationCode {
  id        String    @id @default(uuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  codeHash  String
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId, expiresAt])
  @@map("verification_codes")
}

model PasswordResetToken {
  id        String    @id @default(uuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([tokenHash])
  @@index([userId, expiresAt])
  @@map("password_reset_tokens")
}

model Session {
  id               String   @id @default(uuid())
  sessionTokenHash String   @unique
  userId           String
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt        DateTime
  createdAt        DateTime @default(now())
  lastActiveAt     DateTime @default(now())

  @@index([sessionTokenHash])
  @@index([userId, expiresAt])
  @@map("sessions")
}

model RateLimitBucket {
  id        String   @id @default(uuid())
  key       String   @unique
  count     Int      @default(1)
  expiresAt DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([key, expiresAt])
  @@map("rate_limit_buckets")
}
```

### Table Explanations & Constraints
- **`users`**:
  - Stores identity credentials.
  - `email` has a PostgreSQL database-level `UNIQUE` constraint preventing duplicate user identities at the storage engine level.
  - `passwordHash` is `TEXT NOT NULL`, ensuring an account cannot exist without a cryptographically hashed credential.
  - `emailVerifiedAt` is `TIMESTAMP NULLABLE`, cleanly distinguishing unverified accounts from verified users.
- **`verification_codes`**:
  - Tracks 6-digit email confirmation codes.
  - `codeHash` stores HMAC-SHA256 rather than plaintext code to prevent database leaks from compromising active codes.
  - `expiresAt` (`TIMESTAMP NOT NULL`) enables strict temporal boundary checks.
  - `usedAt` (`TIMESTAMP NULLABLE`) marks single-use consumption.
- **`password_reset_tokens`**:
  - `tokenHash` has a `UNIQUE` constraint and index, preventing collision and accelerating lookups.
  - Single-use lifecycle enforced through `usedAt`.
- **`sessions`**:
  - Stores server-side sessions.
  - `sessionTokenHash` has a `UNIQUE` constraint; only the HMAC hash of the client cookie is stored.
- **`rate_limit_buckets`**:
  - `key` has a `UNIQUE` constraint, allowing atomic transaction upserts across multiple concurrent requests.

### Which constraints make an invalid state impossible?
1. **`users(email) UNIQUE`**: Guarantees concurrent signup requests cannot generate two user records for the same email address.
2. **`password_reset_tokens(tokenHash) UNIQUE`**: Prevents token collision.
3. **`sessions(sessionTokenHash) UNIQUE`**: Guarantees no two active sessions share an identical bearer token.
4. **Foreign Key `ON DELETE CASCADE` across all child tables**: Guarantees orphaned tokens, verification codes, or sessions cannot exist if a user record is purged.

---

## Section 5 — The Concepts

### Password Hashing (bcrypt, cost 10)
#### What it is
bcrypt is an adaptive, intentionally slow password hashing function built on the Blowfish cipher. It is an *adaptive* algorithm in the sense the specification requires: the work factor is a tunable cost parameter, so the algorithm can be made slower over time as hardware improves, without changing the stored format.

#### Why it is needed
General-purpose hashing algorithms like SHA-256 or MD5 execute in nanoseconds on a GPU and can test billions of candidate passwords per second against a stolen database. A deliberately expensive algorithm turns a database dump from "instantly cracked" into a rate-limited guessing problem.

#### How I implemented it
Implemented in `src/lib/security/hash.ts` using the native `bcrypt` package at cost factor 10 (2^10 iterations):
```typescript
const BCRYPT_COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  if (isBcryptHash(hash)) return bcrypt.compare(plain, hash);
  if (isArgon2Hash(hash)) {
    const argon2 = await import("argon2");
    return argon2.verify(hash, plain);
  }
  return false;
}
```
bcrypt embeds the salt and cost factor in the returned string, so the hash is self-describing and requires no separate salt column. Two calls on the same password return different hashes because each uses a fresh 128-bit salt:
```
$2b$10$td5eS4ZvXw6xvSmIyHzYJeJvc…
$2b$10$3cG3vTHbGUmahPpeyQflYg…
```

#### The 72-byte truncation problem, and how I handled it
bcrypt **silently ignores any input past 72 bytes**. I verified this directly: a 72-character password and that same password with 15 extra characters appended both verify against the same hash. This is not a theoretical concern for this app, because the character limit alone does not bound the byte limit — 64 emoji characters is 256 bytes. Two passwords sharing a 72-byte prefix would therefore be accepted interchangeably, which is a genuine authentication weakness.

I capped passwords at 64 characters *and* enforced a 72-byte ceiling in the schema, so the truncation path is unreachable:
```typescript
export const PASSWORD_MAX_BYTES = 72;

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long")
  .max(64, "Password cannot exceed 64 characters")
  .refine((value) => byteLength(value) <= PASSWORD_MAX_BYTES, {
    message: "Password is too long once non-ASCII characters are counted",
  });
```

#### Migrating away from Argon2id
This slice originally used Argon2id at `m=65536, t=3, p=4`, which is memory-hard and is the stronger choice against GPU and ASIC attackers. I moved to bcrypt at cost 10 for familiarity with the algorithm. Because existing rows were already stored as `$argon2id$` hashes, a straight swap would have locked out every current account.

`verifyPassword` therefore detects the hash prefix and dispatches to the matching algorithm, so accounts created before the migration keep working. On every successful sign-in, `needsRehash()` checks whether the stored hash predates current policy, and if so the credential is silently re-hashed with bcrypt. The upgrade is transparent to the user and needs no forced password reset. I verified this end-to-end by storing an Argon2id hash on a seeded account, signing in with it, and confirming the row read `$2b$10$` afterwards.

#### What I chose against, and why
I kept the Argon2id verification path rather than forcing an immediate rehash of all credentials, because a straight swap would have been an outage for existing users. I also chose against PBKDF2 and plain SHA-256; the latter is not adaptive and is explicitly prohibited by the specification.

Honest trade-off: bcrypt at cost 10 is CPU-only and uses ~4 KB per hash, whereas Argon2id at 64 MB is memory-hard, which makes bcrypt materially cheaper to attack in bulk on modern GPUs. Cost 10 is the *minimum* reasonable setting — cost 12 or 14 is stronger and still fast enough for a login. If this were production rather than an assessment slice, that is the first dial I would turn up.

---

### Centralized Schema Validation
#### What it is
The practice of declaring all input constraints (types, lengths, regex, trimming, canonical transformations) in structured schema definitions that run identically on server handlers and client forms.

#### Why it is needed
If validation logic is scattered ad-hoc throughout endpoint handlers, edge cases (e.g., negative lengths, leading/trailing whitespace, missing payload keys) will be missed, creating attack vectors such as injection or corrupted database records.

#### How I implemented it
Declared in `src/lib/validation/auth-schemas.ts` using Zod schemas and executed on server routes via `.safeParse()`:
```typescript
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
        (part) => namePart.test(part) && (part.match(/\p{L}/gu)?.length ?? 0) >= 2,
      );
    },
    { message: "Enter both a first and last name, each at least 2 letters (e.g. Saul Bass)" },
  );

export const signupSchema = z.object({
  name: fullNameSchema,
  email: z.string().trim().toLowerCase().email("A valid email address is required"),
  password: passwordSchema, // min 8, max 64 chars, max 72 bytes, plus 4 character classes
});
```

The name rule is deliberately stricter than a bare length check. A plain `.min(2)` accepts `"Saul"` — a single word that is not a full name. `fullNameSchema` instead requires at least two whitespace-separated parts, each at least two letters, so `"Saul"` and `"Saul B"` are both rejected while `"Saul Bass"` passes. Internal apostrophes and hyphens are allowed (`"Anne-Marie O'Neill"`), and the letter test is Unicode-aware (`\p{L}`), so `"José Álvarez"` and `"Łukasz Nowak"` validate. Digits are not letters, so `"User 1"` is rejected.

Because the same `fullNameSchema` instance drives both the client form and the API route, the browser and the server cannot drift apart. I verified the server rejects a bypassed client with `"Saul"` → `400`.

Password validation requires **a minimum of 8 characters and a maximum of 64**, plus at least one lowercase letter, one uppercase letter, one number, and one special character. The 72-byte ceiling described above applies on top of that.

The error message is generated per failing value and reports **only the next unmet step**, advancing as the user types rather than dumping every outstanding rule at once. `superRefine` is used rather than `refine` because Zod v4 requires `ctx.addIssue` to attach a value-dependent message.

**Validation order is deliberate, and getting it wrong was an actual bug I shipped and then fixed.** The character classes are checked first, in a fixed order; length is the **final gate** on the finished password. My first implementation checked length first, so pressing the very first key produced "Password must be at least 8 characters long" — telling a user with one character typed that they needed eight. The length rule applies to the *entire completed password including everything it must contain*, so it cannot be the first thing reported.

```typescript
export function describePasswordProblem(password: string): string | null {
  if (password.length > 64) return "Password cannot exceed 64 characters.";

  const missing = firstMissingPasswordRequirement(password);
  if (missing) return missing;

  if (password.length < 8) return "Password must be at least 8 characters long.";
  if (byteLength(password) > PASSWORD_MAX_BYTES) return "…";
  return null;
}
```

Keystroke by keystroke:

| Typed so far | Message |
|---|---|
| `a` | Password must contain an uppercase letter. |
| `aA` | Password must contain a number. |
| `aA1` | Password must contain a special character. |
| `aA1!` | Password must be at least 8 characters long. |
| `aA1!bcde` | *(accepted)* |

Pressing `a` immediately satisfies the lowercase requirement and advances to uppercase. Length only appears once all four classes are present, because a password containing every required class but only four characters is still too short — the check is on the finished value, not on what has been typed so far. The 64-character ceiling is the one exception evaluated first, since no further keystroke can repair it.

Because the message advances one step at a time, the user is never asked to fix four things at once. Beneath it, a live checklist (`passwordRequirementStatus`) renders all requirements with a tick as each is satisfied, ordered to match the message — classes first, "Between 8 and 64 characters" last.

The checklist and the message are both **scaffolding**, and scaffolding should not outlive its purpose. It is hidden in two cases: while the field is untouched and empty, so a pristine form does not present as pre-filled with errors; and the moment the password becomes valid, at which point the text under the field is removed entirely rather than leaving four satisfied ticks on screen. The first attempt at this rule was wrong — I gated the checklist on `describePasswordProblem(...) !== null`, but that function returns the length message for an empty string, so an untouched field counted as having a problem and the checklist rendered on page load. Caught it by inspecting the served HTML rather than trusting the logic.

#### Field states: border only, red to green

Field feedback is carried entirely by `aria-invalid`, which has three states rather than two:

| Value | Meaning | Appearance |
|---|---|---|
| `"true"` | Engaged and failing | Red border |
| `"false"` | Engaged and passing | Green border |
| *absent* | Never touched | Neutral border |

```tsx
const isEngaged = (field) => touched[field] || submitAttempted;
const fieldState = (field, ok) =>
  isInvalid(field, ok) ? true : isValid(field, ok) ? false : undefined;
```

Both directions are gated on `isEngaged`. Colouring an untouched field green would congratulate the user for a field they had not filled in, so a pristine form renders three neutral borders.

Invalid fields are **border only** — the input keeps its normal `--bg-input` fill. My first implementation tinted the entire field with `--danger-bg`, and it was worse than it sounds: a large filled block of red reads as a blocking error state even when the text beneath is a single unmet rule, and it overwhelmed the progressive message it was supposed to accompany. Removing the fill also means the red and green states are visually symmetric and carry no extra weight over each other.

#### The submit button is gated, but never trusted

"Create Account" stays disabled until every field passes its schema:

```tsx
const formValid = nameResult.success && emailResult.success && passwordResult.success;
<button disabled={loading || !formValid}>
```

Two details matter here. First, the disabled state **names what is missing** (`Still needed: a valid email, a password meeting the requirements.`). A disabled control with no explanation is a dead end — the user cannot discover what would unlock it.

That hint is scaffolding as well, and follows the same engagement rule as the password checklist rather than being permanent. It is absent on a pristine form, appears once the user has typed in or blurred out of any field, and disappears again the moment the form becomes valid:

```tsx
const formEngaged =
  touched.name || touched.email || touched.password ||
  submitAttempted || name.length > 0 || email.length > 0 || password.length > 0;
const showSubmitHint = formEngaged && !formValid;
```

Gating it on `!formValid` alone — my first version — left a permanent "Still needed: your full name, a valid email, a password meeting the requirements" banner sitting under the button of an untouched page. That is precisely the bulk this rule exists to remove, and it front-loads instructions before the user has done anything. It also reappears if the user deletes a character from a completed field, which is correct: the button has just disabled itself again and owes an explanation.

The button's `aria-describedby` is bound to the same `showSubmitHint` flag, so it is never left pointing at an element that is not rendered.

Second, and more importantly, this is a UX affordance and **not a security control**: it is trivially bypassed by `curl`, by removing the attribute, or by calling the route directly. That is precisely why the server revalidates every field with the same Zod schemas and returns `400` regardless — the `curl`-first test in Appendix A exists to prove the button can be defeated and the request still rejected. Section 5 makes the same argument for the duplicate-email path, where a client-side disabled flag would have hidden a server requirement that genuinely needs handling.

The special-character rule is `/[^A-Za-z0-9\s]/` — any non-alphanumeric, non-whitespace character — rather than a shortlist like `,.@&`. This accepts the full ASCII punctuation range (`!#$%^&*()-_=+[]{}|;:'",.<>/?~\``) and Unicode symbols such as `€` or emoji, so a legitimate password is never rejected for using an unlisted symbol. Note that `\s` is excluded so a space cannot masquerade as the required special character.

The same `describePasswordProblem` logic runs in the Zod schema via `superRefine`, so a bypassed client receives precisely the message the browser would have shown — I verified the server returns `Password must contain an uppercase letter.` for the input `a`, not a length complaint.

**Honest note on this choice.** NIST SP 800-63B recommends *against* composition rules, on the grounds that they drive users toward predictable substitutions (`Password1!`) while adding little real entropy. I implemented them here because the requirement is explicit, and the dynamic messaging is a genuine improvement over a fixed "does not meet requirements" string — the user is told precisely what to fix. But the underlying trade-off is real: `"Str0ngPass!"` is not meaningfully stronger than a long passphrase, and a 16-character random phrase would pass no composition check yet resist guessing far better.

#### What I chose against, and why
I chose against manual `if (!req.body.email)` conditionals. Manual checks are error-prone, duplicate effort, and fail to provide unified error structures to client consumers. I also considered a single character-count regex like `/^.{2,80}$/`, but it would accept single-word names and any run of punctuation; a structured two-part rule states the actual requirement rather than approximating it.

---

### Server-Side Database Rate Limiting & Cooldown
#### What it is
A mechanism that tracks incoming client request counts against defined temporal windows in a persistent database store, enforcing throttling and mandatory cooldown periods.

#### Why it is needed
Without server-side rate limiting, endpoints like `/signin` and `/resend-code` can be abused for credential stuffing, denial-of-service, or email inbox flooding. Frontend countdowns are easily bypassed with direct `curl` requests.

#### How I implemented it
Implemented in `src/lib/security/rate-limiter.ts` as a **single atomic** `INSERT ... ON CONFLICT DO UPDATE` statement, returning `429 Too Many Requests` with a `Retry-After` header:
```typescript
const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
  INSERT INTO rate_limit_buckets ("id", "key", "count", "expiresAt", "createdAt", "updatedAt")
  VALUES (${crypto.randomUUID()}, ${key}, 1, ${expiresAt}, ${now}, ${now})
  ON CONFLICT ("key") DO UPDATE
    SET "count" = CASE
          WHEN rate_limit_buckets."expiresAt" <= ${now} THEN 1
          ELSE rate_limit_buckets."count" + 1
        END,
    "updatedAt" = ${now}
  WHERE rate_limit_buckets."expiresAt" <= ${now}
     OR rate_limit_buckets."count" < ${maxRequests}
  RETURNING "count"
`);
```
The `WHERE` on the `DO UPDATE` is the guard. If the window is live **and** the counter is already at the cap, no row is returned and the request is rate limited. A caller of `resend-code` sees:

```typescript
if (!rateLimit.success) {
  return NextResponse.json(
    { error: "Too many resend attempts...", retryAfterSeconds: rateLimit.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() } }
  );
}
```

**Why atomicity is the whole point.** My first implementation read the counter with `findUnique` and then wrote it with `update`, inside a `$transaction`. That looks safe and is not: Prisma's default isolation is read-committed, so 30 simultaneous sign-in requests all read `count = 0` and then all wrote `count = 1`. **Measured: 13 of 30 concurrent requests were admitted against a limit of 5.** Switching the increment to a conditional `updateMany({ where: { count: { lt: max } } })` fixed the steady-state case, but cold starts still leaked — when the bucket row did not yet exist, every concurrent request took the "create it" branch, each wrote `count = 1`, and each returned success. Only a single-statement upsert closes both windows, because Postgres serialises it and the guard is part of the same statement. After the fix, four consecutive runs of 30 concurrent sign-ins each admitted **exactly 5**.

#### What I chose against, and why
I chose against an in-memory JavaScript `Map` or process-local cache. In-memory limiters reset on server restarts and fail completely in multi-process or serverless environments. I also chose against a read-then-write transaction for the reason above: the transaction gave the *appearance* of atomicity while still permitting a lost-update race.

---

### Database-Backed Server Sessions & HttpOnly Cookies
#### What it is
An authentication architecture where a cryptographically random token is generated on the server, hashed and persisted in the database, while the raw token is delivered to the browser inside an `HttpOnly` cookie.

#### Why it is needed
Storing auth tokens or JWTs in `localStorage` exposes them to immediate exfiltration via Cross-Site Scripting (XSS). Furthermore, stateless tokens cannot be revoked on-demand if a user changes their password or clicks Sign Out.

#### How I implemented it
Implemented in `src/lib/security/session.ts` using `crypto.randomBytes(32)` and Next.js cookies API:
```typescript
cookieStore.set("auth_session", rawToken, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 3600,
});
```

#### What I chose against, and why
I chose against client-stored JWTs. JWTs cannot be revoked server-side without maintaining a revocation list, effectively turning them into more complex database sessions.

---

### Single-Use Token & Verification Code Lifecycle
#### What it is
A token management invariant where every reset token or verification code possesses a strict expiration timestamp and is rendered permanently invalid immediately upon first use.

#### Why it is needed
If tokens are reusable, an attacker who intercepts a link or code in transit can reset the user's password repeatedly or gain unauthorized verification even after the legitimate user completed the action.

#### How I implemented it
Implemented in `src/app/api/auth/verify-email/route.ts` and `reset-password/route.ts` using atomic database transactions:
```typescript
await prisma.$transaction([
  prisma.verificationCode.update({
    where: { id: validRecord.id },
    data: { usedAt: now },
  }),
  prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: now },
  }),
]);
```

#### What I chose against, and why
I chose against deleting rows immediately upon consumption. Storing `usedAt` preserves an audit trail of when and how tokens were consumed, facilitating forensic debugging.

---

### Verification Is Not an Authentication Path
#### What it is
The rule that a handler which *proves* a claim (email ownership via a code) must never also be the handler that *grants* a session for a user who has not proven anything in that request. Each endpoint has exactly one job.

#### Why it is needed
My original `verify-email` handler checked whether the user was already verified and, if so, called `createSession(user.id)` before ever looking at the submitted code. That branch required no proof of anything — it only required knowing an email address. I found it by attacking my own build: an unauthenticated `POST /api/auth/verify-email` with the target's email and a made-up code `"000000"` returned `200`, set a session cookie, and rendered the victim's dashboard as that user. **Any verified account could be taken over with one HTTP request and no password**, regardless of password strength or hashing cost factor.

#### How I implemented it
`src/app/api/auth/verify-email/route.ts` now returns a neutral, session-free response and directs the caller to the sign-in flow:
```typescript
if (user.emailVerifiedAt) {
  // Do NOT create a session here: reaching this point requires no proof of
  // ownership, so minting a session would let anyone who knows a verified
  // email sign in with a guessed code.
  return NextResponse.json(
    { success: true, alreadyVerified: true, message: "Email is already verified. Please sign in." },
    { status: 200 }
  );
}
```
After the fix, the same request returns `200` but sets no cookie, mints no `sessions` row, and the returned cookie is rejected at `/dashboard` with a redirect. The invariant is now enforced and verified in `test-auth-flow.sh` section 11.

#### What I chose against, and why
I chose against returning `403` for an already-verified account. A 403 would let an unauthenticated caller enumerate which email addresses have verified accounts, turning a functional endpoint into an account-existence oracle. The `200` with `alreadyVerified: true` is deliberately vague, and the frontend treats it as "go and sign in" rather than as a success.

---

### Idempotent Signup
#### What it is
An endpoint design guarantee where repeating the exact same account creation request multiple times produces the exact same end state without creating duplicate entities or throwing unhandled server errors.

#### Why it is needed
Users frequently double-click buttons on slow network connections. Without idempotency, duplicate records are created or unhandled unique-constraint database exceptions crash the request.

#### How I implemented it
Implemented in `src/app/api/auth/signup/route.ts` by looking up the email *before* creating, and returning a success-shaped response when the account already exists but is unverified:
```typescript
const existingUser = await prisma.user.findUnique({ where: { email } });
if (existingUser) {
  if (existingUser.emailVerifiedAt) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }
  // Unverified: re-issue a code, but respect the 60s cooldown first
  const recentCode = await prisma.verificationCode.findFirst({
    where: { userId: existingUser.id }, orderBy: { createdAt: "desc" },
  });
  if (recentCode && now.getTime() - recentCode.createdAt.getTime() < 60000) {
    return NextResponse.json({ success: true, message: "Verification code was recently sent." });
  }
  // ... otherwise create a fresh code
}
```
Two layers do the real work. The application check above produces a clean response for the ordinary double-click, and `users(email) UNIQUE` is the backstop for genuine concurrency, where two requests both pass the `findUnique` and race to insert. Verified: 10 simultaneous identical signup requests produced exactly **one** `users` row, and the second submission did not overwrite the stored password hash.

#### What I chose against, and why
I chose against allowing the database unique constraint to throw an unhandled 500 error, and against a client-side "submit disabled" flag. A disabled button does nothing against a direct `curl`, and an unhandled `P2002` leaks schema structure in a stack trace. Relying on the unique index alone would also make the *common* case (a user resubmitting their own form) look like a server error.

---

## Section 6 — What Went Wrong

### Problem 1: Account Takeover — Verification Minted Sessions for Unverified Requests
- **Symptom**: An unauthenticated `POST /api/auth/verify-email` with a known email and a fabricated code returned `200`, set a session cookie, and rendered the target's dashboard. One request, no password.
- **Investigation**: I attacked my own finished build rather than trusting it. The `/verify-email` handler had this branch *above* the code check: `if (user.emailVerifiedAt) { await createSession(user.id); ... }`. Reaching it required knowing only an email address. I confirmed against a verified account (`alice@example.com`) with code `"000000"`, and the dashboard returned `Welcome, Alice Assessment` with a session row now bound to that user in the database.
- **Cause**: One handler doing two jobs. Email verification exists to *prove a claim*; the code path correctly proved it and then granted a session. But the early-return branch for already-verified users skipped the proof entirely and still granted the session. I had written it as a convenience so that a verified user re-submitting would "just work" — which is exactly the assumption that made it an authentication path.
- **Fix**: Removed the `createSession` call from that branch and made it return a neutral `alreadyVerified` response directing the user to sign in. Chose `200` over `403` deliberately, since a `403` would let an anonymous caller enumerate which emails are registered. Now verified in `test-auth-flow.sh` section 11: the request mints no session and the cookie is rejected at `/dashboard`.

### Problem 2: Rate Limiter Leaked Under Concurrency — A `$transaction` Is Not a Lock
- **Symptom**: A limit of 5 sign-in attempts per 15 minutes admitted 13 of 30 simultaneous requests. The visible bucket counter said `5`, so the database looked healthy while the endpoint was wide open.
- **Investigation**: Fired 30 concurrent requests against one email and counted non-429 responses, then compared that to `rate_limit_buckets`. A sequential loop was correctly limited at 5/30, so the limiter was not simply misconfigured. The old code did `findUnique` then `update` inside `prisma.$transaction`; Prisma defaults to read-committed, so every request read the same `count` and then wrote over it — a lost update.
- **Cause**: I treated a transaction as if it serialised the read and the write. It does not; it only guarantees atomicity *within* each statement, and the two statements were independent. A second, subtler variant of the same mistake survived my first fix: moving to a conditional `updateMany` closed the steady-state case, but on a cold start every concurrent request found no row, took the "create bucket" branch, each wrote `count = 1`, and each returned success — so the counter under-reported how many requests actually arrived.
- **Fix**: Replaced the read-then-write with one `INSERT ... ON CONFLICT DO UPDATE ... WHERE <window expired OR count < max> RETURNING count`. Being a single statement, Postgres serialises it, and the guard cannot be bypassed by a concurrent insert. Verified across four consecutive runs of 30 concurrent sign-ins: **exactly 5 admitted each time.**

### Problem 3: The Flow Was Uncompletable In A Browser
- **Symptom**: Sign-up succeeded and redirected to `/verify-email`, which told the user a code "was sent" — but no email exists in this slice. Codes only reached the server console, so verification could not be completed by clicking, and because verification and sign-in are the only two paths to a session, the placeholder dashboard was unreachable entirely.
- **Investigation**: Reported as "I cannot see the dashboard or any sign an account was created." Traced the session sources: `createSession` is called from exactly three places (signin, verify-email, and password reset's implicit purge), and the latter two both require a token that only the mailer can produce.
- **Cause**: The mailer (`src/lib/services/mail.ts`) is a `console.log` plus an in-memory array. That was a reasonable placeholder, but the UI was written as though a real transport existed, so it made a promise the backend did not keep. The limitation was documented in Section 7 while the interface silently implied otherwise.
- **Fix**: Added `src/components/DevMailbox.tsx`, a dev-only panel that polls `/api/dev/outbox` and shows the code and reset link for the current address, wired into `/verify-email`, `/forgot-password`, and `/signin`. The endpoint it reads already returns `404` when `NODE_ENV === "production"`, so the panel renders nothing in production. I kept the console output as well, since it is what the terminal-based evidence captures.

### Problem 4: TypeScript TS2769 Compilation Error on Zod Parameters
- **Symptom**: During `npm run build`, Next.js compilation aborted with `error TS2769: No overload matches this call` on lines containing `z.string({ required_error: "..." })`.
- **Investigation**: Inspected the installed Zod version definitions. Discovered that the `$ZodStringParams` type definition in the latest installed version no longer accepts `required_error` directly within `z.string()`.
- **Cause**: Breaking API shift in recent Zod releases favoring chainable validator methods.
- **Fix**: Replaced `{ required_error }` options with explicit `.min(1, "Field is required")` chained calls across all validation schemas in `src/lib/validation/auth-schemas.ts`.

### Problem 5: PostgreSQL P1010 Access Denial During Prisma Migration
- **Symptom**: Running `npx prisma migrate dev` returned error: `Error: P1010: User was denied access on the database '(not available)'`.
- **Investigation**: Checked PostgreSQL server status with `pg_isready` and inspected active roles via `psql -l`. Confirmed PostgreSQL was running locally on port 5432, owned by the macOS user account `leksyd`.
- **Cause**: The default `.env` connection string `postgresql://localhost:5432/assessment_auth` omitted the username, causing PostgreSQL to attempt connection as an unauthenticated or anonymous user which was rejected.
- **Fix**: Updated `DATABASE_URL` in `.env` to explicitly include the system user, allowing migrations to run cleanly. `.env.example` documents the username as part of the expected format.

### Problem 6: `prisma.config.ts` Imported an Undeclared Dependency
- **Symptom**: A fresh clone reported `Cannot find module 'dotenv/config'` when running `npx prisma migrate dev`, even though the local `node_modules` was fine.
- **Investigation**: `npm ls dotenv` reported it only as a transitive dependency of `prisma` → `@prisma/config` → `c12`. It resolved locally only because npm hoists it to the top level; nothing in `package.json` declared it, so a different package manager or a non-hoisted install would fail.
- **Cause**: `prisma.config.ts` does `import "dotenv/config"` while `dotenv` appears nowhere in `dependencies` or `devDependencies`.
### Problem 7: Next.js 15+ Asynchronous `cookies()` Invocation
- **Symptom**: Session helper calls threw runtime warnings and undefined reads when invoking `cookies().get(SESSION_COOKIE_NAME)`, and `createSession` failed to attach the cookie.
- **Investigation**: Reviewed the App Router release notes for the `next/headers` API evolution rather than assuming the previous synchronous signature.
- **Cause**: In Next.js 15+, `cookies()` became an asynchronous function returning a Promise. Calling `.get()` on the returned object without awaiting yields `undefined`, so the token read as missing.
- **Fix**: Updated all three session functions in `src/lib/security/session.ts` — `getCurrentSession()`, `createSession()`, and `destroySession()` — to `await cookies()`.

### Problem 8: Password Validation Asked For Length Before Content
- **Symptom**: Pressing the first key in the password field produced "Password must be at least 8 characters long." The message never mentioned a missing uppercase letter until eight characters had been typed, so the field told a user with one character to fix a length problem.
- **Investigation**: Reproduced the message at every keystroke rather than only at submit. I typed `a`, then `aA`, then `aA1`, then `aA1!` and recorded what the form said at each step.
- **Cause**: `describePasswordProblem()` checked `length < 8` before evaluating the character-class requirements. My reasoning — "tell the user about length first" — was backwards. The 8-to-64 range constrains the *finished* password including everything it must contain, so it cannot be the first thing reported. Length is a property of the result; character presence is a property of the input so far.
- **Fix**: Inverted the precedence. Character classes are now checked first in a fixed order, and length is evaluated last as the final gate, with the 64-character ceiling kept first because no further keystroke can repair it. The identical ordering is mirrored in the Zod `superRefine` so the server response matches the form, and I added four regression tests asserting that `"a"` reports the uppercase step rather than length.

### Problem 9: I Put The User's Email Address In The URL
- **Symptom**: After signing up, the browser navigated to `/verify-email?email=jane.doe%40example.com`. The email the user had typed sat in the address bar, in browser history, and in the server access log.
- **Investigation**: Asked where the value was going rather than only where it was read. I grepped for every navigation that interpolates user input and found two: `signup/page.tsx` and `signin/page.tsx`, both building `/verify-email?email=...`. Auditing the rest of the flow turned up a worse instance of the same mistake — the password-reset link shipped `${appUrl}/reset-password?token=<rawToken>`, putting a single-use account-recovery token in the access log of every deployment that received a reset request.
- **Cause**: Convenience. `router.push` with a query parameter is the path of least resistance, and the value was genuinely needed on the next page. I never asked the question that mattered: *who else can read this URL?* A query string is not a private channel. It is written to the web server's access log, retained in browser history for anyone with the device, attached to the `Referer` header sent to every third-party resource on the page, and picked up by any analytics or error-reporting script. For the reset token that is close to a credential leak, because the token alone is sufficient to reset the account.
- **Fix**: Values now travel in `sessionStorage` instead. The email is written on navigation and read by the verify page; the reset token arrives in the URL **fragment** (`#token=`), which browsers never transmit to the server, and `consumeTokenFromHash()` immediately moves it into `sessionStorage` and calls `history.replaceState` so the address bar is scrubbed and the history entry that carried the token is overwritten. `Referrer-Policy: no-referrer` is set on every route as a backstop. Six regression tests in section 12 assert the absence of `?token=`, the presence of `#token=`, and that no email appears in any link.

Two things I want to be straight about rather than let the fix imply more than it does. First, storage reads happen after hydration, so the values cannot be rendered on the server; the verify page therefore shows a neutral state and fills in after mount, and a direct visit to `/verify-email` with no pending email simply asks the user for their address. Second, **Next.js serializes a page's `searchParams` into its own RSC flight payload regardless of whether the application reads them.** If someone hand-types `/verify-email?email=x@y.com`, that string is echoed into the page source by the framework. My code never reads it, and the application never puts it there, so the leak path is closed — but the claim I can honestly make is "this app does not write PII to URLs", not "this app cannot be made to display one".

---

## Section 7 — What This Slice Does Not Handle

1. **Transactional Email Transport (SMTP/SES)**: This is the largest honest limitation. There is no mail provider, so `src/lib/services/mail.ts` writes codes and reset links to the server console and an in-memory outbox. In development, `src/components/DevMailbox.tsx` surfaces those in the browser so the flow is completable by clicking; in production that component renders nothing and the flow is unusable until a real transport is wired. A production version would use Resend, Postmark, or Amazon SES behind the same two functions.
2. **Distributed Redis Caching**: Rate limiting is backed by PostgreSQL and is now a single atomic statement, so it is correct under concurrency. It is still a database write on every auth request; a high-traffic deployment would move counters to Redis while keeping Postgres for durable state.
3. **Multi-Factor Authentication (MFA/TOTP)**: Omitted because it was explicitly outside the scope of Assessment 1.
4. **Social OAuth Providers**: Excluded in accordance with global scope rules (Rule 1.1).
5. **Account Lockout Beyond Temporal Throttling**: Failed logins are throttled by rate limit rather than triggering permanent lockout, avoiding an automated denial-of-service against a known legitimate email.
6. **Session Expiry Cleanup Job**: Expired sessions are deleted lazily on access (`getCurrentSession`) and on password reset. Nothing sweeps the table on a schedule, so long-idle deployments accumulate dead rows.
7. **Unverified-Email Sign-In**: A user cannot sign in until they verify. There is no grace period, no "resend on sign-in" prompt beyond the `403` response, and no reminder email.

---

## Section 8 — If I Built This Again

I would spend the first hour writing the adversarial test script instead of the features. Every serious defect in this slice — the account takeover, the rate limiter that admitted 13 of 30 requests while its own counter read `5`, and the verification flow that could not be completed in a browser at all — was found by running code against code I had just written and trusted. I built it, declared it done, and all three were still there. The takeover in particular was not subtle in hindsight; it was a two-line branch I wrote on purpose, for convenience, and I never once asked "what does this branch let someone do who has proved nothing?" A checklist of the spec's requirements, checked by a script that tries to break each one, would have caught all of these before a single line of documentation was written. The lesson is not that I needed more tests at the end; it is that the tests are the work, and the features are what is left over once the tests pass.

---

## Appendix A — Required Evidence & Test Proofs

### Evidence 1: Database Password Hashing (bcrypt, with legacy Argon2id rows)
Direct PostgreSQL query of the `users` table. New accounts are bcrypt at cost 10 (`$2b$10$`); pre-migration rows remain `$argon2id$` until their owner next signs in, at which point `needsRehash()` upgrades them in place. The `algorithm` column is derived from the hash prefix, which is exactly what `verifyPassword` dispatches on:
```text
psql -d assessment_auth -c "SELECT u.email, u.name, left(u.\"passwordHash\",29) AS hash, CASE WHEN u.\"passwordHash\" LIKE '\$argon2id\$%' THEN 'argon2id (legacy)' WHEN u.\"passwordHash\" LIKE '\$2b\$%' THEN 'bcrypt' ELSE 'UNKNOWN' END AS algorithm FROM users u ORDER BY u.email;"

        email        |       name       |             hash              |     algorithm
---------------------+------------------+-------------------------------+-------------------
 alice@example.com   | Alice Assessment | $argon2id$v=19$m=65536,p=4,t= | argon2id (legacy)
 user1@example.com   | User One         | $2b$10$PCRVxbomsHAE3da5PaeILe | bcrypt
 user2@example.com   | User Two         | $argon2id$v=19$m=65536,p=4,t= | argon2id (legacy)
```
The password `Str0ngPass!` was accepted and stored as `$2b$10$…`, while `alllowercase` was rejected naming only the next unmet step (`an uppercase letter`). The plaintext appears nowhere in the table; `users` has no `password` column at all.

### Evidence 2 & 3: Direct curl Signup Bypassing Browser Validation
**Curl Command**:
```bash
curl -i -X POST http://127.0.0.1:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name": "A", "email": "not-an-email", "password": "123"}'
```
**Server Response (Status 400 Bad Request)**:
```text
HTTP/1.1 400 Bad Request
content-type: application/json

{"error":"Validation failed","details":{"name":["Enter both a first and last name, each at least 2 letters (e.g. Saul Bass)"],"email":["A valid email address is required"],"password":["Password must contain a lowercase letter."]}}
```

This is the client-validation-bypass proof: a hand-written `curl` request that skips every browser check entirely. The server still rejects all three fields, including the name, which would have passed a naive `.min(2)` length check as `"A"` is exactly one character short. The password `"123"` contains a number and two special characters but no lowercase letter, so the only message is `Password must contain a lowercase letter.` — notably **not** a complaint about being 3 characters long, because character classes are evaluated before length.

### Evidence 4: Rate Limiting Trigger (Status 429 & Retry-After)
**Server Response when request threshold exceeded**:
```text
HTTP/1.1 429 Too Many Requests
content-type: application/json
retry-after: 557

{"error":"Too many signup attempts. Please try again later.","retryAfterSeconds":557}
```

### Evidence 5: Verification Code in Database, Live (Not Yet Expired)
```text
psql -d assessment_auth -c "SELECT vc.id, vc.\"userId\", substring(vc.\"codeHash\" from 1 for 20) AS hash_preview, vc.\"expiresAt\", vc.\"usedAt\", (vc.\"expiresAt\" > (now() AT TIME ZONE 'UTC')) AS still_valid FROM verification_codes vc JOIN users u ON u.id=vc.\"userId\" WHERE u.email='<email>';"

                  id                  |                userId                |     hash_preview     |        expiresAt        | usedAt | still_valid
--------------------------------------+--------------------------------------+----------------------+-------------------------+--------+-------------
 53890586-f19f-44b6-8dc2-02487605c53e | 37a7a696-b6b2-49bb-a8af-ed972e5b1353 | bfbfba45d2b357a21821 | 2026-09-30 18:55:06.196 |        | t
(1 row)
```
`codeHash` is an HMAC-SHA256 digest, not the code. Submitting the real code at this point succeeds:
```text
POST /api/auth/verify-email  {"email":"<email>","code":"<real code>"}
HTTP/1.1 200 OK
{"success":true,"message":"Email successfully verified. Welcome!"}
```

### Evidence 6: The Same Record After Expiry
Identical query, after moving `expiresAt` into the past. Same `id`, same `codeHash` — only the timestamp changed, and `usedAt` is still NULL, proving the row was rejected on expiry rather than consumed:
```text
                  id                  |                userId                |     hash_preview     |        expiresAt        | usedAt | still_valid
--------------------------------------+--------------------------------------+----------------------+-------------------------+--------+-------------
 53890586-f19f-44b6-8dc2-02487605c53e | 37a7a696-b6b2-49bb-a8af-ed972e5b1353 | bfbfba45d2b357a21821 | 2026-09-30 18:40:06.253 |        | f
(1 row)
```
The server rejects it:
```text
POST /api/auth/verify-email  {"email":"<email>","code":"<same code>"}
HTTP/1.1 400 Bad Request
{"error":"Invalid or expired verification code."}
```

> Note on the SQL: `expiresAt` is `TIMESTAMP(3)`, which Prisma writes in UTC, while `now()` returns `timestamptz` in the session time zone. Comparing them directly makes a live code look expired on a UTC+ machine, so the query uses `now() AT TIME ZONE 'UTC'`. This bit me while producing this evidence and is worth remembering — the application is unaffected because Prisma does the comparison in JavaScript, but ad-hoc evidence queries can mislead.

### Evidence 7: Rate Limiter Under Concurrency (30 Simultaneous Requests, Limit 5)
Before the atomic-upsert fix, 13 of 30 concurrent sign-ins were admitted. After:
```text
run 1: 5/30 allowed (limit 5), bucket=5
run 2: 5/30 allowed (limit 5), bucket=5
run 3: 5/30 allowed (limit 5), bucket=5
run 4: 5/30 allowed (limit 5), bucket=5
```

### Evidence 8: Account Takeover Attempt (Now Blocked)
Unauthenticated request against a verified account, with a fabricated code and no password:
```text
POST /api/auth/verify-email  {"email":"<verified email>","code":"000000"}

# Before the fix:
HTTP/1.1 200 OK
set-cookie: auth_session=<token>; HttpOnly; SameSite=lax      <-- session granted
GET /dashboard  ->  "Welcome, Alice Assessment"

# After the fix:
HTTP/1.1 200 OK
{"success":true,"alreadyVerified":true,"message":"Email is already verified. Please sign in."}
# no set-cookie; sessions table unchanged; the same cookie is rejected at /dashboard with 307
```

---

## Appendix B — Defence Question Walkthrough

1. **Why this hashing algorithm?** bcrypt, an adaptive algorithm built on Blowfish, at cost factor 10. It is adaptive in the sense the specification requires — the work factor is tunable, so the algorithm can be slowed over time as hardware improves without changing the stored format. Each hash embeds its own random 128-bit salt and cost factor, so identical passwords produce different hashes and no separate salt column is needed. I originally implemented Argon2id and moved to bcrypt for familiarity; the honest comparison is that Argon2id is memory-hard and therefore stronger against bulk GPU attacks, and I have documented that trade-off in Section 5 rather than pretending bcrypt is the better algorithm. bcrypt at cost 10 is the minimum reasonable setting; cost 12+ is the first dial I would turn up in production.
2. **What happens if the cost factor is reduced?** Every guess becomes proportionally cheaper, so an offline attacker's throughput rises sharply — dropping from cost 10 to cost 8 makes each attempt roughly 4× faster. Critically, the cost is encoded in the hash string itself, so existing hashes continue to verify and nothing visibly breaks; the weakening is silent and affects every account created under the old setting. The factor is only safe to raise, never lower, and raising it still leaves older hashes on the weaker setting until those users next sign in. This project handles exactly that with `needsRehash()`, which upgrades a stored credential to current policy on successful sign-in — the same mechanism used here to migrate legacy Argon2id rows to bcrypt.
3. **Where exactly is the session created?** `createSession()` in `src/lib/security/session.ts`, called from exactly two places: `/api/auth/signin` and `/api/auth/verify-email` (and only on a code that actually verified a real account). Password reset deliberately *deletes* sessions rather than creating one.
4. **What is inside the session cookie?** A single opaque 32-byte random hex string, nothing else — no user id, no email, no claims. Only its HMAC-SHA256 hash is stored server-side in `sessions.sessionTokenHash`, so a database dump yields no usable cookies. The cookie is `HttpOnly` (invisible to JS, so XSS cannot read it), `SameSite=Lax`, `Path=/`, and `Secure` when `NODE_ENV === "production"`.
5. **What happens when signup is submitted twice in the same second?** The second request finds the existing unverified user, sees a verification code created less than 60 seconds ago, and returns the same success shape with a "recently sent" message. No second account, no second email, and critically the stored password hash is not overwritten. Verified with 10 simultaneous identical requests: exactly one `users` row. The `users(email)` unique index is the backstop if two requests genuinely race past the lookup.
6. **Which validation rules cannot be enforced by the client, and why?** Everything that depends on server state: whether the email is already registered, whether the code or reset token is valid, unexpired, and unused, whether the password matches the stored hash, whether the caller has a session, and the rate-limit counters. The client can mirror the *shape* of a rule (length, format) but has no way to observe any of these, and a client is not a trust boundary — `curl` bypasses it entirely.

---

## Appendix C — Scope Confirmation

Per the scope rules, this slice contains no landing or marketing page, no social login, no two-factor authentication, no profile editing, no settings, and no dashboard functionality beyond the signed-in user's name and a sign-out button. `/` is a redirect, not a page. Every screen present exists because the assessed flow needs it.
