# OEM Backend

Cloudflare Workers + Hono backend for Open Endfield Map. The service provides
authentication, progress sync, UGC uploads, moderation, and related API routes.

## Requirements

- Node.js 22 or later
- pnpm
- Cloudflare account and Wrangler access for remote development or deployment

## Local Development

Install dependencies:

```sh
pnpm install
```

Create local configuration:

```sh
cp .dev.vars.example .dev.vars
```

Fill in the required values in `.dev.vars`, especially:

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- OAuth credentials if social sign-in is needed
- `OPENAI_API_KEY` if local AI moderation is enabled
- Email provider settings if email delivery is being tested

Run the Worker locally:

```sh
pnpm run dev
```

For local development with the Google translation proxy:

```sh
pnpm run dev:local
```

The local Worker listens on `http://127.0.0.1:8787`. Apply local D1 migrations
when needed:

```sh
pnpm run db:migrate:local
```

## Checks

```sh
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run check
```

`pnpm run check` runs the complete local validation workflow, including type
checking, linting, tests, and deployment dry-runs.

## Deployment

The normal deployment reads secrets from `.dev.vars`, applies remote `DB`
migrations, and deploys the backend:

```sh
pnpm run deploy
```

Use a different secrets file with `DEPLOY_VARS_FILE`:

```sh
DEPLOY_VARS_FILE=.production.vars pnpm run deploy
```

Remote database migrations can be applied separately:

```sh
pnpm run db:migrate:remote
```

WAF synchronization is opt-in. Configure `.waf.vars` from
`.waf.vars.example`, then run:

```sh
WAF_SYNC=1 pnpm run deploy
```

## Sending A Moderation Warning

The warning endpoint sends the fixed English template for repeated or bulk
posting of context-free external links. It resolves the recipient from
`publicUid`; do not pass an email address or a display name.

Deploy the current backend first, then call the production endpoint with an
administrator Bearer token:

```sh
curl -X POST https://api.opendfieldmap.org/moderation/v1/warnings \
  -H 'Authorization: Bearer ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  --data '{"publicUid":"XXXXXXX"}'
```

The endpoint requires the admin role and requires
`LOCK_MODERATION_ENDPOINTS=false`. The message is sent from
`Open Endfield Map Moderation <moderation@opendfieldmap.org>` and includes:

- the account display name and `publicUid`;
- the detected repeated or bulk link-only posting behavior;
- links to the [Community Guidelines](https://blog.opendfieldmap.org/docs/community-guidelines)
  and [UGC Content Statement](https://blog.opendfieldmap.org/docs/ugc);
- the request to stop, the possible suspension consequence, and the appeal
  address.

Successful responses include the selected `publicUid`, provider, and delivery
message ID. A missing UID returns `404`; invalid authentication or insufficient
permissions returns `401` or `403`.

## Main Routes

- `GET /health/v1/status`
- Better Auth routes under `/auth/v1/*`
- `GET /me/v1/overview`
- `GET /me/v1/contributions`
- `GET /progress/v1/state`
- `POST /progress/v1/sync`
- Upload and public UGC routes under `/uploads/v1/*`
- Moderation routes under `/moderation/v1/*`
- Admin reports under `/admin/v1/reports/*`

## Project Layout

- `src/index.ts`: Worker entry point and scheduled/queue handlers
- `src/app.ts`: Hono application and route mounting
- `src/routes/`: HTTP route modules
- `src/services/`: moderation, upload, progress, and notification logic
- `src/repositories/`: D1 data access
- `src/lib/`: authentication, email, configuration, and shared utilities
- `migrations/`: D1 schema migrations

## Public Read Request Lifetimes

Public image and comment cache misses use invocation-local batch loaders. Never
store unfinished KV or D1 reads in module-global maps keyed by bindings or marker
IDs: a later invocation must not depend on another invocation's I/O or
`waitUntil` lifetime. Batch and deduplicate misses within a single invocation;
use Workers Cache and KV for sharing completed public data across invocations.
The generic KV JSON reader also performs its own read for each call rather than
sharing a pending promise across requests.

The public read client keeps at most eight marker reads active until their bodies
have been consumed. It applies the requested image/comment limits immediately
after each body is parsed, rather than retaining every full cache entry until
the slowest marker finishes. This changes retention, not returned content,
ranking, nested replies, cache keys, TTLs, or SQL access paths. A single large
cache entry must still be parsed in full; this is not a general payload-size or
comment-depth limit.

Partial responses remain `private, no-store`. Failed reads are not automatically
retried, and no direct-D1 fallback is introduced. Each failed aggregate emits
one diagnostic with total/failed marker counts and at most three samples of
failure stage (`fetch` or `body`), upstream status, elapsed time, and a bounded
error message. All-failed reads are logged too. These diagnostics do not measure
Workers Cache hits or D1 latency individually.

Validate changes with:

```sh
pnpm exec vitest run src/publicRead src/middleware/cache src/services/upload/ugcReadEfficiency.spec.ts
pnpm run typecheck
pnpm run lint
```

After deployment, compare equal traffic-normalized windows for public-read
hangs, 5xx, partial responses, and p95/p99 latency. Separate Workers Cache misses
that hit KV from those reaching D1, and compare D1 rows read per cold query.
Removing cross-invocation coalescing can increase simultaneous cold KV/D1 reads;
do not claim lower database usage without measuring it. Cache keys and TTLs are
unchanged, so this fix needs no cache purge or database migration.

The incident report ending at 2026-09-06 22:49 Asia/Shanghai alone cannot establish
an out-of-memory failure or an error rate without invocation totals. Check
`exceededMemory` outcomes and heap profiles separately. Auth and locator modules
also contain cross-invocation pending-work maps; locator value caches currently
lack explicit size bounds. Those paths require a separate lifetime/cache audit,
especially before changing credential-refresh synchronization. They are not
changed by the public-read fix.
