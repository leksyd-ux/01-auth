# LinkedIn Post — Authentication Slice

Frontend countdown timers are not security boundaries. 

When building an email verification or password reset flow, it is tempting to put a 60-second JavaScript timer on a "Resend Code" button and call it a day. But an attacker doesn't use your browser. A single `curl` loop can hit your API 50 times in two seconds, blowing through your transactional email quota or inundating a target inbox.

For Assessment 1 of our software engineering bootcamp, I built a production-minded authentication slice with Next.js (App Router), TypeScript, Prisma, and PostgreSQL. Scope was intentionally constrained to core identity: account creation, email verification, credential sign-in, password reset, and session termination at a minimal placeholder dashboard.

The core lesson? Security invariants must live at the server and database tiers.

To protect the verification flow, I implemented a database-backed rate limiter alongside a server-enforced cooldown. When a user requests a code, the server writes a cryptographic hash of that code to PostgreSQL with an expiration timestamp (`expiresAt`). If the user submits a second resend within 60 seconds, the server doesn't consult the client; it checks the timestamp of the latest record directly in the database. If less than 60 seconds have elapsed, it immediately aborts with an `HTTP 429 Too Many Requests` status code and a calculated `Retry-After: <seconds>` response header.

We also replaced standard general-purpose hashing with Argon2id—configured with 64 MB of RAM (`m=65536`), 3 iterations (`t=3`), and 4 parallel threads (`p=4`). This memory-hardness ensures that even if our database was breached, brute-force GPU cracking is computationally prohibitive.

Frontend validation exists purely for user feedback. The real perimeter is your database constraints, atomic transactions, and server-side invariants.

Check out the code and the full 8-section technical documentation here: https://github.com/leksyd/assessment-01-auth

#SoftwareEngineering #WebSecurity #NextJS #PostgreSQL #TypeScript #FullStackDevelopment
