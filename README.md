# OEM Backend

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
	- Email OTP verification: /auth/v1/email-otp/send-verification-otp, /auth/v1/sign-in/email-otp, /auth/v1/email-otp/verify-email
	- Password reset: /auth/v1/forget-password (send magic link)
	- Social login: /auth/v1/sign-in/social
- Compatibility endpoints: /auth/v1/register (email+password+otp bridge)
- Session endpoints: /auth/v1/session, /auth/v1/logout
- GET /progress/v1/state
- POST /progress/v1/sync
- POST /uploads/v1/images
- GET /uploads/v1/images
- GET /moderation/v1/pending (pioneer/admin)
- GET /moderation/v1/images/orphans (admin)
- PATCH /moderation/v1/:id/status (pioneer/admin)
- POST /moderation/v1/run (admin)
- POST /moderation/v1/run-once (admin)
- DELETE /moderation/v1/test-images (admin; marks matching submissions stale and retains objects)
- DELETE /moderation/v1/stale (admin; rejected by append-only retention policy)

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
- BETTER_AUTH_URL
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- DISCORD_CLIENT_ID
- DISCORD_CLIENT_SECRET
- OPENAI_API_KEY (optional in local mode)
- ENABLE_SCHEDULED_MODERATION (optional, default: false)
- RESEND_AUTH_KEY
- RESEND_FROM_EMAI
- EMAIL_TEMPLATE_DEFAULT_LOCALE (optional: zh-CN / zh-HK / en / ja / ko, default: en)
- Optional overrides for TTL and upload constraints
