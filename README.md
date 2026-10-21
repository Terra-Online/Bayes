# OEM Backend

Cloudflare Workers + Hono backend for Open Endfield Map. The service provides
authentication, progress sync, UGC uploads, moderation, and related API routes.

## Requirements

- Node.js 22.12.0 or later
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

Before committing, run `pnpm run lint:fix` and `pnpm run format`, then verify
`pnpm run format:check` and `pnpm run lint` pass. Before pushing, run
`pnpm run check` and resolve failures. Recheck after any further changes.

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

- the account `publicUid`;
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
- `src/app.ts`: Hono initialization, global middleware, and error handling
- `src/routes/route.ts`: route prefixes and mounting order
- `src/routes/<topic>/createRoutes.ts`: each topic's Hono routes, with handlers
  and HTTP tests in the same topic directory
- `src/routes/schema/`: HTTP input schemas, composed from business contracts
  where needed
- `src/routes/notify/liveUpgrade.ts`: raw notification WebSocket upgrade entry,
  called by the Worker before Hono to preserve the upgrade response
- `src/services/`: moderation, upload, progress, and notification logic
- `src/publicRead/`: public read client, cache origin loaders, and shared contracts
- `src/repositories/`: D1 data access
- `src/lib/`: authentication, email, configuration, and shared utilities
- `migrations/`: D1 schema migrations

Binding, locator, and official-mark sync have separate route topics. Binding
queries live in `repositories/binding`, locator cache and ticket logic in
`services/locator`, and official-mark conversion in `services/sync`. The ignored
marker lookup remains at `src/routes/binding/officialMarkerHashToPointId.json`
because its path is shared across local worktrees.

This layout migration preserves existing business workflows inside handlers.
Binding credential refresh and pending-session helpers still use Hono context
under `routes/binding`; separating those interfaces is follow-up work. Internal
storage and protocol validators remain with their owning modules. WAF generation
reads the mounts in `routes/route.ts` and excludes the local demo route.

## Performance and Runtime Checks

Public image and comment reads combine per-marker Workers Cache entries with KV
and D1 origin reads. Each invocation deduplicates its missing markers and reads
D1 in batches of up to 100. The public read client consumes up to eight marker
responses concurrently, applies the requested limits, and preserves marker order.
Partial responses include `failedMarkerIds` and use `private, no-store`.

Authentication creates a request-scoped Better Auth instance and reuses validated
schema metadata. Locator caches hold completed values per database and environment;
credential refreshes use conditional database updates to preserve concurrent edits.
Managed position sockets release their timers and listeners when closed. Progress
outbox delivery clears its deadline as soon as delivery settles.

Run the local regression checks:

```sh
pnpm test
pnpm run test:auth-runtime
pnpm run test:worker-lifecycle
pnpm run typecheck
pnpm run lint
```

The native runtime checks use local workerd, D1, KV, and WebSocket peers through
Miniflare. Production acceptance uses existing Cloudflare telemetry: compare
versioned, traffic-normalized windows for CPU, endpoint latency, outcomes, SQL
rows read, cache origin calls, and connection recovery.

Performance reports and measurement evidence are kept locally and ignored by Git.
