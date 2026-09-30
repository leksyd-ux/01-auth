# DOCUMENTATION — Assessment 1: Authentication Slice

---

## Section 1 — What This Is

This project is a production-minded authentication slice built with Next.js (App Router), TypeScript, Prisma ORM, and PostgreSQL. It delivers a complete, secure identity flow consisting of account creation, server-enforced email verification with cooldown timers, credential authentication, single-use password resets, and database-backed session management that terminates at a minimal placeholder dashboard. All security invariants—including adaptive password hashing with Argon2id, sliding-window rate limiting, input schema validation, and session lifecycle controls—are strictly validated and enforced on the server and database tiers.

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
8. **Run Verification Test Suite**:
   ```bash
   chmod +x scripts/verify-all.sh
   ./scripts/verify-all.sh
   ```

---

## Section 3 — The Flow, Step By Step

### Flow 1: Account Creation & Email Verification
1. **User Action**: The user visits `/signup`, completes their Name, Email, and Password, and clicks "Create Account".
2. **Frontend Transmission**: `SignupPage` (`src/app/signup/page.tsx`) mirrors validation using `signupSchema` and sends a `POST` request with JSON `{ name, email, password }` to `/api/auth/signup`.
3. **Server Processing**:
   - The route handler `/api/auth/signup/route.ts` verifies client IP rate limits (`checkRateLimit('signup:ip', 5, 600)`).
   - Validates input via Zod `signupSchema`.
   - Checks if an account exists: if existing and unverified, it idempotently refreshes the verification code; if existing and verified, returns `409 Conflict`.
   - Hashes password using Argon2id (`hashPassword`).
   - Generates a 6-digit random code, hashes it with HMAC-SHA256, and stores it in `verification_codes` with a 15-minute expiration.
   - Dispatches the code to the development outbox (`src/lib/services/mail.ts`) and console.
   - Returns `201 Created`. The browser redirects to `/verify-email?email=...`.
4. **User Action**: The user checks their console/outbox, inputs the 6-digit code on `/verify-email`, and clicks "Verify & Continue".
5. **Frontend Transmission**: `VerifyEmailPage` (`src/app/verify-email/page.tsx`) sends `{ email, code }` via `POST` to `/api/auth/verify-email`.
6. **Server Processing**:
   - `/api/auth/verify-email/route.ts` verifies rate limits and validates schema.
   - Computes HMAC-SHA256 of candidate code and finds active unexpired, unused record in `verification_codes`.
   - In an atomic transaction, marks `usedAt = now` on the code and sets `emailVerifiedAt = now` on the user.
   - Invokes `createSession(user.id)` in `src/lib/security/session.ts`, storing hashed session in `sessions` table and attaching an `HttpOnly`, `SameSite=Lax` cookie.
   - Redirects user to `/dashboard`.

### Flow 2: Returning User Sign In
1. **User Action**: User visits `/signin`, enters email and password, and submits.
2. **Frontend Transmission**: `SigninPage` (`src/app/signin/page.tsx`) sends `POST` with credentials to `/api/auth/signin`.
3. **Server Processing**:
   - `/api/auth/signin/route.ts` checks sliding rate limit (`5 attempts / 15 minutes` per IP + email).
   - Queries `users` table for email.
   - Verifies candidate password against stored Argon2 hash using `verifyPassword`.
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
   - Dispatches reset link `${NEXT_PUBLIC_APP_URL}/reset-password?token=<rawToken>`.
   - Always returns uniform success response to prevent email enumeration.
4. **User Action**: User navigates to the reset URL, types a new password matching policy, and submits.
5. **Frontend Transmission**: `ResetPasswordPage` (`src/app/reset-password/page.tsx`) sends `{ token, password }` via `POST` to `/api/auth/reset-password`.
6. **Server Processing**:
   - `/api/auth/reset-password/route.ts` hashes token and queries `password_reset_tokens` for an unexpired, unused record.
   - Hashes new password with Argon2id.
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

### Password Hashing (Argon2id)
#### What it is
Argon2id is a modern, memory-hard adaptive password hashing function designed to resist both GPU and custom ASIC brute-force attacks by requiring significant RAM allocations alongside CPU iterations.

#### Why it is needed
General-purpose hashing algorithms like SHA-256 or MD5 execute in nanoseconds on standard GPUs. Without memory-hard computational cost, an attacker who extracts a database dump can crack millions of passwords per second using offline dictionary and rainbow-table attacks.

#### How I implemented it
Implemented in `src/lib/security/hash.ts` using `argon2.hash()` configured with 64MB memory, 3 iterations, and 4 threads:
```typescript
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB RAM
    timeCost: 3,       // 3 iterations
    parallelism: 4,    // 4 threads
  });
}
```

#### What I chose against, and why
I chose against bcrypt and PBKDF2. While bcrypt is established, it is limited to an 8-character salt, 72-byte password truncation, and has zero memory-hardness, making it vulnerable to specialized FPGA attack clusters compared to Argon2id (the winner of the Password Hashing Competition).

---

### Centralized Schema Validation
#### What it is
The practice of declaring all input constraints (types, lengths, regex, trimming, canonical transformations) in structured schema definitions that run identically on server handlers and client forms.

#### Why it is needed
If validation logic is scattered ad-hoc throughout endpoint handlers, edge cases (e.g., negative lengths, leading/trailing whitespace, missing payload keys) will be missed, creating attack vectors such as injection or corrupted database records.

#### How I implemented it
Declared in `src/lib/validation/auth-schemas.ts` using Zod schemas and executed on server routes via `.safeParse()`:
```typescript
export const signupSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  email: z.string().trim().toLowerCase().email("A valid email address is required"),
  password: z.string().min(10, "Password must be at least 10 characters long").max(128),
});
```

#### What I chose against, and why
I chose against manual `if (!req.body.email)` conditionals. Manual checks are error-prone, duplicate effort, and fail to provide unified error structures to client consumers.

---

### Server-Side Database Rate Limiting & Cooldown
#### What it is
A mechanism that tracks incoming client request counts against defined temporal windows in a persistent database store, enforcing throttling and mandatory cooldown periods.

#### Why it is needed
Without server-side rate limiting, endpoints like `/signin` and `/resend-code` can be abused for credential stuffing, denial-of-service, or email inbox flooding. Frontend countdowns are easily bypassed with direct `curl` requests.

#### How I implemented it
Implemented in `src/lib/security/rate-limiter.ts` using PostgreSQL transactions with `RateLimitBucket`, returning `429 Too Many Requests` with a `Retry-After` header:
```typescript
const rateLimit = await checkRateLimit(`resend:${ip}:${email}`, 3, 900);
if (!rateLimit.success) {
  return NextResponse.json(
    { error: "Too many attempts", retryAfterSeconds: rateLimit.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() } }
  );
}
```

#### What I chose against, and why
I chose against an in-memory JavaScript `Map` or process-local cache. In-memory limiters reset on server restarts and fail completely in multi-process or serverless environments.

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

### Idempotent Signup
#### What it is
An endpoint design guarantee where repeating the exact same account creation request multiple times produces the exact same end state without creating duplicate entities or throwing unhandled server errors.

#### Why it is needed
Users frequently double-click buttons on slow network connections. Without idempotency, duplicate records are created or unhandled unique-constraint database exceptions crash the request.

#### How I implemented it
Implemented in `src/app/api/auth/signup/route.ts`:
```typescript
const existingUser = await prisma.user.findUnique({ where: { email } });
if (existingUser && !existingUser.emailVerifiedAt) {
  // Gracefully refresh code subject to cooldown and inform user
  return NextResponse.json({ success: true, message: "Verification code sent.", email });
}
```

#### What I chose against, and why
I chose against allowing the database unique constraint to throw an unhandled 500 error. Unhandled database exceptions leak schema structure and degrade user experience.

---

## Section 6 — What Went Wrong

### Problem 1: TypeScript TS2769 Compilation Error on Zod Parameters
- **Symptom**: During `npm run build`, Next.js compilation aborted with `error TS2769: No overload matches this call` on lines containing `z.string({ required_error: "..." })`.
- **Investigation**: Inspected the installed Zod version definitions. Discovered that the `$ZodStringParams` type definition in the latest installed version no longer accepts `required_error` directly within `z.string()`.
- **Cause**: Breaking API shift in recent Zod releases favoring chainable validator methods.
- **Fix**: Replaced `{ required_error }` options with explicit `.min(1, "Field is required")` chained calls across all validation schemas in `src/lib/validation/auth-schemas.ts`.

### Problem 2: PostgreSQL P1010 Access Denial During Prisma Migration
- **Symptom**: Running `npx prisma migrate dev` returned error: `Error: P1010: User was denied access on the database '(not available)'`.
- **Investigation**: Checked PostgreSQL server status with `pg_isready` and inspected active roles via `psql -l`. Confirmed PostgreSQL was running locally on port 5432, owned by the macOS user account `leksyd`.
- **Cause**: The default `.env` connection string `postgresql://localhost:5432/assessment_auth` omitted the username, causing PostgreSQL to attempt connection as an unauthenticated or anonymous user which was rejected.
- **Fix**: Updated `DATABASE_URL` in `.env` to explicitly include the system user `postgresql://leksyd@localhost:5432/assessment_auth?schema=public`, allowing migrations to run cleanly.

### Problem 3: Next.js 15+ Asynchronous `cookies()` Invocation
- **Symptom**: Initial session helper tests threw a runtime warning and undefined read errors when invoking `cookies().get(SESSION_COOKIE_NAME)`.
- **Investigation**: Reviewed Next.js App Router release notes regarding the `next/headers` API evolution.
- **Cause**: In Next.js 15+, `cookies()` was migrated from a synchronous accessor to an asynchronous function returning a Promise.
- **Fix**: Updated all session management functions (`getCurrentSession()`, `createSession()`, `destroySession()`) in `src/lib/security/session.ts` to `await cookies()`.

---

## Section 7 — What This Slice Does Not Handle

1. **Transactional Email Transport (SMTP/SES)**: In this local slice, emails are written to console logs and an in-memory dev outbox (`/api/dev/outbox`). Production environments would require integration with Amazon SES, Resend, or Postmark.
2. **Distributed Redis Caching**: Rate limiting is backed by PostgreSQL. While completely reliable and ACID-compliant for thousands of users, multi-region deployments with millions of requests per second would benefit from an in-memory Redis cluster.
3. **Multi-Factor Authentication (MFA/TOTP)**: Omitted because it was explicitly outside the scope of Assessment 1.
4. **Social OAuth Providers**: Excluded in accordance with global scope rules (Rule 1.1).
5. **Account Lockout Beyond Temporal Throttling**: Currently, failed logins trigger exponential rate limiting rather than permanent account locking, avoiding automated denial-of-service against legitimate user emails.

---

## Section 8 — If I Built This Again

If I built this again from scratch, I would integrate WebAuthn passkey support as a first-class credential primitive alongside Argon2id password hashing. Passkeys eliminate password reuse and credential stuffing attacks entirely at the protocol level, dramatically reducing the threat surface while delivering a superior authentication experience.

---

## Section 9 — Required Evidence & Test Proofs

### Evidence 1: Database Password Hashing (Argon2id)
Direct PostgreSQL query of `users` table verifying that passwords are stored as memory-hard Argon2id hashes:
```text
psql -d assessment_auth -c "SELECT id, email, name, substring(\"passwordHash\" from 1 for 35) as hash_prefix, \"emailVerifiedAt\" FROM users WHERE email='alice@example.com';"

                  id                  |       email       |       name       |             hash_prefix             |     emailVerifiedAt     
--------------------------------------+-------------------+------------------+-------------------------------------+-------------------------
 5d568202-baad-407b-8f94-2b9f2b79dcd3 | alice@example.com | Alice Assessment | $argon2id$v=19$m=65536,p=4,t=3$JVPB | 2026-09-30 17:49:58.161
```

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

{"error":"Validation failed","details":{"name":["Name must be at least 2 characters"],"email":["A valid email address is required"],"password":["Password must be at least 10 characters long"]}}
```

### Evidence 4: Rate Limiting Trigger (Status 429 & Retry-After)
**Server Response when request threshold exceeded**:
```text
HTTP/1.1 429 Too Many Requests
content-type: application/json
retry-after: 557

{"error":"Too many signup attempts. Please try again later.","retryAfterSeconds":557}
```

### Evidence 5: Verification Code in Database (Before Expiry/Use)
```text
psql -d assessment_auth -c "SELECT id, \"userId\", substring(\"codeHash\" from 1 for 25) as hash_preview, \"expiresAt\", \"usedAt\" FROM verification_codes;"

                  id                  |                userId                |       hash_preview        |        expiresAt        | usedAt 
--------------------------------------+--------------------------------------+---------------------------+-------------------------+--------
 a7c0594e-f286-417b-b8bf-0eb536ee1db2 | 5d568202-baad-407b-8f94-2b9f2b79dcd3 | 27729daaeb99289a2141b4f4f | 2026-09-30 18:03:59.118 |        
```

### Evidence 6: Verification Record After Consumption
```text
                  id                  |                userId                |       hash_preview        |        expiresAt        |         usedAt          
--------------------------------------+--------------------------------------+---------------------------+-------------------------+-------------------------
 a7c0594e-f286-417b-b8bf-0eb536ee1db2 | 5d568202-baad-407b-8f94-2b9f2b79dcd3 | 27729daaeb99289a2141b4f4f | 2026-09-30 18:03:59.118 | 2026-09-30 17:49:58.161
```
