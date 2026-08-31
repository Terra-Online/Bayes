# OEM Backend

Cloudflare Workers + Hono backend for:

- Better Auth based authentication and role-based access control
- Progress sync with Redis-first cache and D1 fallback
- UGC upload flow with signed upload ticket
- Async moderation queue with OpenAI moderation API
- Cron jobs for progress flush and moderation processing

This is a foundation implementation based on PRD and is intentionally incremental.

## WAF allowlist

The production deploy can synchronize a Cloudflare custom WAF rule from the
top-level `app.route(...)` mounts in `src/app.ts`. The generated
`config/waf-allowlist.json` is checked into the repository so CI can detect
route/config drift.

```bash
pnpm run waf:sync       # regenerate the JSON and print the expression
pnpm run waf:check      # fail when the generated JSON is stale
pnpm run waf:sync:apply # update the Cloudflare ruleset
```

`waf:sync:apply` reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and (for
an account-scoped token) `CLOUDFLARE_ACCOUNT_ID` from
`.waf.vars` (copy `.waf.vars.example`). Use a dedicated token scoped to the
`opendfieldmap.org` zone with `Zone Read` and `Zone WAF Edit`. Do not put this
token in `.dev.vars`: the deploy script passes `.dev.vars` to Wrangler as a
Worker secrets file. The normal deploy script only applies WAF when
`WAF_SYNC=1` is explicitly set; use `WAF_ENV_FILE=/path/to/waf.vars` to select
another file.

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
- Session endpoints: /auth/v1/session, /auth/v1/sign-out
- Account endpoints: /auth/v1/list-accounts, /auth/v1/link-social, /auth/v1/unlink-account
- Profile endpoint: PATCH /auth/v1/profile
- User center: GET /me/v1/overview, GET /me/v1/contributions
- GET /progress/v1/state
- POST /progress/v1/sync
- POST /uploads/v1/images
- GET /uploads/v1/images
- GET /moderation/v1/pending (pioneer/admin)
- GET /moderation/v1/images/orphans (admin)
- GET /admin/v1/reports/registrations (admin; daily registrations and source distribution from `users`)
- GET /admin/v1/reports/translations (admin; persisted translation trends, language shares, and flows)
- GET /admin/v1/reports/ugc-likes (admin; image likes and comment vote activity)
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
- EMAIL_PROVIDER_MODE (resend_only / resend_then_cloudflare / cloudflare_only)
- EMAIL_PRIMARY_PROVIDER (resend / cloudflare, optional compatibility setting)
- EMAIL_FALLBACK_ENABLED (optional, default: true)
- EMAIL_RESEND_DAILY_LIMIT (optional, default: 100)
- EMAIL_FROM_EMAIL / EMAIL_FROM_NAME
- EMAIL_TEMPLATE_DEFAULT_LOCALE (optional: zh-CN / zh-HK / en / ja / ko, default: en)
- Optional overrides for TTL and upload constraints

Email sending uses Resend first and the Cloudflare `OEM_ID_MAILS` binding as the optional
fallback. Resend's daily reservation and provider state are tracked in the existing
Upstash Redis instance with short-lived UTC-date keys. Configure the Cloudflare Email
Sending domain and binding before enabling `resend_then_cloudflare` in production.

`EMAIL_FROM_EMAIL` and `EMAIL_FROM_NAME` are the canonical sender settings. The legacy
`RESEND_FROM_EMAIL` and `RESEND_FROM_NAME` variables remain supported as a compatibility
fallback, but should not be added to new deployments.
