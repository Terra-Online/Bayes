# Local development

Run commands from the Bayes repository root. Requirements are Node.js 22.12.0+
and pnpm; Docker is needed for local container image conversion.

## Install and prepare data

```sh
pnpm install --frozen-lockfile
```

Three JSON modules imported by the backend are intentionally absent from a
public checkout. Copy the committed templates only if the destination is absent:

```sh
cp -n src/lib/karma/karmaConfig.template.json src/lib/karma/karmaConfig.json
cp -n src/routes/binding/officialMarkerHashToPointId.template.json src/routes/binding/officialMarkerHashToPointId.json
mkdir -p src/data
cp -n templates/imageCoverageManifest.template.json src/data/imageCoverageManifest.json
```

See [data templates](../templates/README.md) for field contracts and limitations.
The empty mapping returns no mapped official point IDs; the empty coverage
manifest returns no coverage regions. Neither is a current game dataset.
The karma template uses zero placeholders for configurable policy values.
Fill in your own thresholds, rewards, limits, and evaluation parameters before
testing karma behavior. It is a schema example, not an operational policy;
code may clamp some zero values to a minimum. Tests that assume particular
policy values need an appropriate local test configuration.

With the Atlos game data available, regenerate the real coverage manifest:

```sh
pnpm run coverage-manifest:update -- ../Atlos/talos
```

The generator reads Atlos region, marker, type, and game translation data and
writes the ignored `src/data/imageCoverageManifest.json`. Review the generated
source metadata and totals before using it for operational coverage reports.

## Configure the Worker

```sh
cp -n .dev.vars.example .dev.vars
```

Set a random `BETTER_AUTH_SECRET` (at least 32 characters) and keep
`BETTER_AUTH_URL="http://127.0.0.1:8787"` for local work. Generate a secret with:

```sh
openssl rand -hex 32
```

Configure only the integrations needed for your task. The example file lists
common variables; the complete binding inventory is in
[`src/types/app.ts`](../src/types/app.ts), with defaults in
[`src/lib/config.ts`](../src/lib/config.ts).

| Capability | Configuration |
| --- | --- |
| Browser client | `BETTER_AUTH_URL`, `CORS_ORIGINS`, `TRUSTED_ORIGINS`; include the actual local frontend origin |
| Redis-backed limits and binding sessions | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`; use your own development service |
| Service identifier hashing | `SERVICE_ID_HMAC_SECRET`; use an independent random value for an installation |
| Email registration and reset | Provider policy, sender identity, and `RESEND_AUTH_KEY` or the Cloudflare mail binding |
| Social login | Credentials for each provider being tested; callbacks must target the local backend |
| Bound account credentials | `ENDFIELD_CREDENTIAL_SECRET`; see `src/routes/binding/credentials.ts` for key selection |
| AI moderation | `OPENAI_API_KEY` and a configured moderation queue |
| Comment translation | `GOOGLE_TRANSLATE_*` service account and language settings |
| Image delivery | `UGC_ASSET_BASE_URL`, upload MIME/size settings, and the transcoder binding |

Empty external credentials do not emulate the corresponding service. Unit tests
and isolated runtime fixtures provide a way to work without those services.
Never commit `.dev.vars`, `.dev.vars.local`, provider keys, or account credentials.

## Migrate and run

```sh
pnpm run db:migrate:local
```

### Fresh database migration caveat

The current migration chain stops at `0017_drop_users_ef_pass.sql` on a new
empty database with `no such column: "ef_pass"`. Earlier checked-in migrations
do not create this historical column. Once migrations `0001`–`0016` have
succeeded, use this compatibility step **only in that fresh local database**,
then resume the migrations:

```sh
pnpm exec wrangler d1 execute DB --local --command 'ALTER TABLE users ADD COLUMN ef_pass TEXT;'
pnpm run db:migrate:local
```

Migration `0017` removes the temporary column again. Do not apply this workaround
to a remote or existing installation. If using `--env local`, add `--env local`
to both the execute and migrations commands so they target the same local state.

### Start the server

```sh
pnpm run dev
```

For API work without the image container or Docker:

```sh
pnpm exec wrangler dev --enable-containers=false
```

Image processing that requires the transcoder is unavailable in that mode.

Wrangler uses local D1, KV, R2, and Durable Object state for its local runtime.
The committed configuration also declares queues, mail, and a container; a full
integration run may need Docker and additional provider configuration. Review
[`wrangler.toml`](../wrangler.toml) when running your own installation.

```sh
curl http://127.0.0.1:8787/health/v1/status
```

A `200` here confirms the HTTP entrypoint responds. It does not validate email,
Redis, image conversion, queues, or upstream Endfield access.

For the local Google translation proxy, use `pnpm run dev:local`. This wrapper
starts Wrangler with `--env local` and uses `.dev.vars.local` when present.
Prepare that file from the example and apply local migrations for that environment:

```sh
cp -n .dev.vars.example .dev.vars.local
pnpm exec wrangler d1 migrations apply DB --local --env local
pnpm run dev:local
```

Fill its values before starting. The proxy defaults to `http://127.0.0.1:7897`;
set `OEM_DEV_UPSTREAM_PROXY` for another address. `pnpm run dev:remote` uses
remote resources and is not part of the local quick start.

## Feature locks

The example config locks progress, upload mutations, moderation, and scheduled
jobs. Set the relevant flag to `false` in your local vars file to exercise it:

| Flag | Scope |
| --- | --- |
| `LOCK_PROGRESS_ENDPOINTS` | All `/progress/v1/*` routes, including statistics |
| `LOCK_UPLOAD_ENDPOINTS` | Upload and content mutation handlers using the upload lock; public reads remain accessible |
| `LOCK_MODERATION_ENDPOINTS` | All `/moderation/v1/*` routes |
| `LOCK_SCHEDULED_JOBS` | Scheduled karma evaluation and moderation backfill; progress recovery still runs |

The first three default to locked when absent. Scheduled jobs default to unlocked
in code, while the example explicitly locks them. Queue consumers are separate
entrypoints and are not stopped by `LOCK_SCHEDULED_JOBS`.

`LOCAL_UPLOAD_AUTO_APPROVE` and `SKIP_AI_MODERATION` alter moderation behavior;
use them only deliberately in an isolated development setup. They are not needed
for source checks.

## Verification

| Command | Coverage |
| --- | --- |
| `pnpm run typecheck` | Backend TypeScript |
| `pnpm run lint` | ESLint rules |
| `pnpm test` | Vitest suites |
| `pnpm run test:auth-runtime` | Auth and D1 regressions in local workerd/Miniflare |
| `pnpm run test:worker-lifecycle` | Worker resource lifetimes and WebSocket cleanup |
| `pnpm run logger:check` | Logger types, lint, tests, and dry-run bundle |
| `pnpm run check` | Formatting, WAF artifact, both typechecks, lint, Vitest, native runtime suites, and logger dry-run bundle |

Native runtime fixtures use local resources and synthetic credentials rather than
production services. Container checks are documented in
[`containers/oem_imgTrans/README.md`](../containers/oem_imgTrans/README.md).
The full check does not run those Docker checks or exercise live integrations.

If a check reports a missing JSON import, finish the template setup first.
If `waf:check` reports drift after changing route mounts, run `pnpm run waf:sync`
and review the generated allowlist. `pnpm run check` does not apply remote WAF
rules or remote database migrations.
