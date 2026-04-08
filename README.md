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

- GET /api/health
- Better Auth native endpoints under /api/auth/* (for example /api/auth/sign-up/email, /api/auth/sign-in/email, /api/auth/get-session, /api/auth/sign-out)
- Compatibility endpoints: /api/auth/register, /api/auth/login, /api/auth/session, /api/auth/logout
- GET /api/progress
- POST /api/progress/sync
- POST /api/uploads/presign
- PUT /api/uploads/direct/:ticketId
- GET /api/moderation/pending (moderator/admin)
- PATCH /api/moderation/:id/status (moderator/admin)
- POST /api/moderation/run-once (admin)

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
- OPENAI_API_KEY (optional in local mode)
- Optional overrides for TTL and upload constraints

### 3) Configure Wrangler bindings

Edit wrangler.toml and update:

- d1 database_id
- r2 bucket_name if needed

### 4) Apply local D1 migration

pnpm run db:migrate:local

This applies both domain schema and Better Auth schema migrations.

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

Register:

curl -i -X POST http://127.0.0.1:8787/api/auth/register \
	-H "content-type: application/json" \
	-d '{"email":"dev@example.com","password":"devpassword123","nickname":"DevUser01"}'

Login:

curl -i -X POST http://127.0.0.1:8787/api/auth/login \
	-H "content-type: application/json" \
	-d '{"email":"dev@example.com","password":"devpassword123"}'

Use returned token to access protected API:

curl -i http://127.0.0.1:8787/api/progress \
	-H "authorization: Bearer <TOKEN>"

### 4) Progress conflict test

- First sync with version 1 should pass.
- Sync again with version 1 should return 409.
- Sync with version 2 should pass.

### 5) Upload and moderation smoke test

- POST /api/uploads/presign
- PUT binary to returned uploadUrl with matching content-type
- Verify submission appears in GET /api/moderation/pending (moderator/admin role)
- POST /api/moderation/run-once as admin

## Data and Consistency Behavior

- Progress read path: Redis first, fallback to D1, then backfill Redis
- Progress write path: write to Redis and mark dirty user
- Background flush: every 5 minutes writes dirty progress to D1
- Version conflict: sync returns 409 if incoming version <= server version
- Upload path: issue one-time upload ticket, then upload binary via ticket endpoint
- Moderation path: submission starts with audit_status=0 and is moved to queue

## Security Baseline in This Skeleton

- Better Auth session and token handling
- Role checks (normal/moderator/admin)
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

- Auth flow: Better Auth register -> login -> get-session -> logout
- Progress flow: cold read fallback to D1 and Redis backfill
- Sync flow: stale version conflict and valid version acceptance
- Upload flow: presign ticket + direct upload + pending submission creation
- Moderation flow: queue consumption and status update

### End-to-end scenario

- User registers and logs in
- User syncs progress
- User uploads image/comment
- Submission enters pending state
- Moderation worker updates status to approved/rejected

### Non-functional checks

- Rate limiting behavior for normal/moderator/admin
- Redis outage fallback behavior
- D1 write flush behavior under burst updates
- Idempotency and retry behavior for moderation jobs

## Known Gaps / Next Steps

- Add role management endpoints (promote/demote moderator/admin)
- Add explicit audit tables for moderation attempts and job retries
- Add OpenAPI spec and request/response schema docs
- Add automated tests (Vitest + integration harness)
- Add deployment pipeline and environment separation
