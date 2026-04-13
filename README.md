# Bayes Backend (MVP Skeleton)

Cloudflare Workers + Hono backend for:

- Better Auth based authentication and role-based access control
- Progress sync with Redis-first cache and D1 fallback
- UGC upload flow with signed upload ticket
- Async moderation queue with OpenAI moderation API
- Cron jobs for progress flush and moderation processing

This is a foundation implementation based on PRD and is intentionally incremental.

## Tech Stack

- Cloudflare Workers
- Hono
- Cloudflare D1
- Cloudflare R2
- Upstash Redis
- OpenAI Moderation API

## Repository Structure

- src/index.ts: Worker entry with fetch + scheduled cron
- src/app.ts: API app setup and route mounting
- src/routes/: Route modules
- src/middleware/: Auth, rate limit, request id, error handling
- src/services/: progress, upload, moderation business flows
- src/repositories/: users, submissions data access
- src/lib/auth.ts: Better Auth instance factory
- migrations/: D1 schema

## API Endpoints (MVP)

- GET /health/v1/status
- Better Auth native endpoints under /auth/v1/*
	- Email login/registration: /auth/v1/sign-up/email, /auth/v1/sign-in/email
	- Email OTP verification: /auth/v1/email-otp/send-verification-otp, /auth/v1/email-otp/verify-email
	- Password reset: /auth/v1/forget-password (send magic link)
	- Social login: /auth/v1/sign-in/social
- Compatibility endpoints: /auth/v1/register -> /auth/v1/sign-up/email, /auth/v1/login -> /auth/v1/sign-in/email
- Session endpoints: /auth/v1/get-session, /auth/v1/logout
- GET /progress/v1/state
- POST /progress/v1/sync
- POST /uploads/v1/presign
- PUT /uploads/v1/direct/:ticketId
- GET /moderation/v1/pending (pioneer/admin)
- PATCH /moderation/v1/:id/status (pioneer/admin)
- POST /moderation/v1/run-once (admin)

## User Group and Karma Model

- users.role stores one-letter group code only: n/p/a/s/r
	- n = normal
	- p = pioneer
	- a = admin
	- s = suspend
	- r = robot
- points is internal-only and should not be returned to client payloads.
- karma is derived from points and returned to client as 0-5.
- Current karma thresholds:
	- 0: [0, 50)
	- 1: [50, 200)
	- 2: [200, 400)
	- 3: [400, 800)
	- 4: [800, 1500)
	- 5: [1500, +inf)

## Local Development

### 1) Install

Node.js 20+

Install dependencies:

pnpm install

### 2) Configure environment

Copy environment template:

cp .dev.vars.example .dev.vars

Then fill values in .dev.vars:

- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- BETTER_AUTH_SECRET (at least 32 chars, random)
- BETTER_AUTH_URL (for local: http://127.0.0.1:8787)
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- DISCORD_CLIENT_ID
- DISCORD_CLIENT_SECRET
- OPENAI_API_KEY (optional in local mode)
- RESEND_AUTH_KEY
- RESEND_FROM_EMAIL (optional, default: noreply@opendfieldmap.org)
- EMAIL_TEMPLATE_DEFAULT_LOCALE (optional: zh-CN / zh-HK / en / ja / ko, default: en)
- Optional overrides for TTL and upload constraints

### 3) Configure Wrangler bindings

Edit wrangler.toml and update:

- d1 database_id
- r2 bucket_name if needed

### 4) Apply local D1 migration

pnpm run db:migrate:local

This applies both domain schema and Better Auth schema migrations.

## Local D1 Operations Guide

Use these commands when you need to frequently inspect or modify local user test data.

Inspect users schema:

pnpm exec wrangler d1 execute DB --local --command "PRAGMA table_info(users);"

List users:

pnpm exec wrangler d1 execute DB --local --command "SELECT uid, email, role, nickname, uid_number, uid_suffix, points, karma FROM users ORDER BY created_at DESC LIMIT 50;"

Update nickname by uid:

pnpm exec wrangler d1 execute DB --local --command "UPDATE users SET nickname='new_name', nickname_customized=1, last_active=CURRENT_TIMESTAMP WHERE uid='YOUR_UID';"

Update group code by uid:

pnpm exec wrangler d1 execute DB --local --command "UPDATE users SET role='p' WHERE uid='YOUR_UID';"

Update points and recalc karma by uid:

pnpm exec wrangler d1 execute DB --local --command "UPDATE users SET points=900, karma=CASE WHEN 900 >= 1500 THEN 5 WHEN 900 >= 800 THEN 4 WHEN 900 >= 400 THEN 3 WHEN 900 >= 200 THEN 2 WHEN 900 >= 50 THEN 1 ELSE 0 END WHERE uid='YOUR_UID';"

Reset one user progress:

pnpm exec wrangler d1 execute DB --local --command "UPDATE users SET progress_version=0, progress_marker='', points=0, karma=0 WHERE uid='YOUR_UID';"

### 5) Start dev server

pnpm run dev

Default endpoint:

- http://127.0.0.1:8787

### 6) Trigger cron manually (local)

When using Wrangler local dev, scheduled events can be simulated from Wrangler tools. If unavailable in your local setup, call moderation run endpoint via admin account and keep cron logic validated in staging.

## Atlos Local Integration and Testing

### 1) Start Bayes backend

Run in Bayes:

pnpm install
pnpm run db:migrate:local
pnpm run dev

Backend URL: http://127.0.0.1:8787

### 2) Start Atlos frontend

Run in Atlos talos directory:

pnpm install
pnpm dev

Frontend URL: http://localhost:5173

### 3) Auth flow smoke test (curl)

Start social sign-in (Google):

curl -i -X POST http://127.0.0.1:8787/auth/v1/sign-in/social \
	-H "content-type: application/json" \
	-d '{"provider":"google"}'

Start social sign-in (Discord):

curl -i -X POST http://127.0.0.1:8787/auth/v1/sign-in/social \
	-H "content-type: application/json" \
	-d '{"provider":"discord"}'

Then finish OAuth in browser and call get-session:

curl -i http://127.0.0.1:8787/auth/v1/get-session

Email registration and login are enabled:

curl -i -X POST http://127.0.0.1:8787/auth/v1/register \
	-H "content-type: application/json" \
	-d '{"email":"user@example.com","password":"StrongPass123!","name":"Demo User"}'

curl -i -X POST http://127.0.0.1:8787/auth/v1/login \
	-H "content-type: application/json" \
	-d '{"email":"user@example.com","password":"StrongPass123!"}'

Verify signup email with OTP (6 digits):

curl -i -X POST http://127.0.0.1:8787/auth/v1/email-otp/verify-email \
	-H "content-type: application/json" \
	-d '{"email":"user@example.com","otp":"123456"}'

## Where Auth Method Is Configured

- The allowed login/registration methods are configured in src/lib/auth.ts.
- In createAuth(...):
  - emailAndPassword.enabled controls email/password registration and login.
  - socialProviders controls enabled OAuth providers (google/discord).
	- basePath controls auth route mount prefix (/auth/v1).
- Auth routes are mounted from src/routes/auth.ts and proxied to auth.handler(...).

### 4) Progress conflict test

- First sync with version 1 should pass.
- Sync again with version 1 should return 409.
- Sync with version 2 should pass.

### 5) Upload and moderation smoke test

- POST /uploads/v1/presign
- PUT binary to returned uploadUrl with matching content-type
- Verify submission appears in GET /moderation/v1/pending (pioneer/admin role)
- POST /moderation/v1/run-once as admin

## Data and Consistency Behavior

- Progress read path: Redis first, fallback to D1, then backfill Redis
- Progress write path: write to Redis and mark dirty user
- Background flush: every 5 minutes writes dirty progress to D1
- Version conflict: sync returns 409 if incoming version <= server version
- Upload path: issue one-time upload ticket, then upload binary via ticket endpoint
- Moderation path: submission starts with audit_status=0 and is moved to queue

## Security Baseline in This Skeleton

- Better Auth session and token handling
- Role checks (n/p/a/s/r with pioneer/admin moderation permissions)
- Per-minute rate limiting with role-based quotas
- MIME whitelist and max upload size checks

## Test Plan (full plan, tests not yet implemented)

### Unit tests

- Better Auth session parsing and middleware mapping
- User profile bootstrap from Better Auth session
- Progress version conflict logic (409)
- MIME whitelist and upload size validation
- Role guard and rate limit window logic

### Integration tests

- Auth flow: email sign-up -> email OTP verify -> email sign-in -> get-session -> logout
- Auth flow: Better Auth social sign-in (google/discord) -> get-session -> logout
- Progress flow: cold read fallback to D1 and Redis backfill
- Sync flow: stale version conflict and valid version acceptance
- Upload flow: presign ticket + direct upload + pending submission creation
- Moderation flow: queue consumption and status update

### End-to-end scenario

- User completes email sign-up and verifies email with OTP
- User logs in with email/password or social login
- User syncs progress
- User uploads image/comment
- Submission enters pending state
- Moderation worker updates status to approved/rejected

### Non-functional checks

- Rate limiting behavior for n/p/a/s/r
- Redis outage fallback behavior
- D1 write flush behavior under burst updates
- Idempotency and retry behavior for moderation jobs

## Known Gaps / Next Steps

- Add role management endpoints (promote/demote moderator/admin)
- Add explicit audit tables for moderation attempts and job retries
- Add OpenAPI spec and request/response schema docs
- Add automated tests (Vitest + integration harness)
- Add deployment pipeline and environment separation
