# Assessment 1 — Authentication Slice

Production-minded authentication flow built with Next.js (App Router), TypeScript, PostgreSQL, and Prisma ORM.

## Core Features
- **bcrypt Hashing with Legacy Compatibility**: New credentials use bcrypt at cost 10; existing Argon2id hashes verify transparently and rehash on successful sign-in.
- **Database-Backed Sessions**: HMAC-signed, HTTP-only session cookies with server-side revocation.
- **Atomic Rate Limiting**: PostgreSQL-backed limits enforced in a single statement, including concurrent requests.
- **Verification and Reset Lifecycle**: Email verification, password reset, and token handling that avoids putting sensitive values in URLs.
- **Development Mailbox**: A dev-only panel surfaces verification codes and reset links so the flow is completable without an email provider.

## Quick Start
```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env

# Run database migrations
npx prisma migrate dev

# Start local server on port 3000
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Unauthenticated visits redirect to `/signin`.

## Verification
```bash
bash test-auth-flow.sh
```

## Documentation
See [DOCUMENTATION.md](./DOCUMENTATION.md) for the architecture, threat analysis, and evidence breakdown.
