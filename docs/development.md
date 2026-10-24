# Local development

Run commands from the repository root after completing environment setup and
local data initialization.

## Install dependencies

```sh
pnpm install --frozen-lockfile
```

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
| Bound account credentials | `ENDFIELD_CREDENTIAL_SECRET`; see `src/services/official/auth/credentials.ts` for key selection |
| AI moderation | `OPENAI_API_KEY` and a configured moderation queue |
| Comment translation | `GOOGLE_TRANSLATE_*` service account and language settings |
| Image delivery | `UGC_ASSET_BASE_URL`, upload MIME/size settings, and the transcoder binding |

Empty external credentials do not emulate the corresponding service. Unit tests
and isolated runtime fixtures provide a way to work without those services.
Never commit `.dev.vars`, `.dev.vars.local`, provider keys, or account credentials.

Comment translation caches prefer the configured `GOOGLE_TRANSLATE_GLOSSARY_VERSION`.
If that revision has no translation, they reuse the latest stored result for the
same normalized text, target language, provider, and glossary resource. Explicit
source-language requests also require the same source language. A glossary revision
therefore applies to new translations without forcing existing comments to be
translated again. Reused results retain their original version and translation
time; cache repair only writes KV and does not add or update D1 report records.

## Migrate and run

```sh
pnpm run db:migrate:local
```

Fresh databases can apply the entire migration chain directly. Migration `0004`
creates an empty historical compatibility column that `0017` removes; the final
schema does not contain `ef_pass`. Already-applied migrations are not replayed.

### Recover a previously interrupted local migration

If a fresh local database initialized with the older migration files already
completed `0001`–`0016` and stopped at `0017_drop_users_ef_pass.sql` with
`no such column: "ef_pass"`, run this compatibility step once in that database,
then resume the migrations:

```sh
pnpm exec wrangler d1 execute DB --local --command 'ALTER TABLE users ADD COLUMN ef_pass TEXT;'
pnpm run db:migrate:local
```

Migration `0017` removes the temporary column again. New databases do not need
this recovery step. Do not run it on a remote database or an installation that
has already applied `0017`. If using `--env local`, add `--env local`
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

## WAF changes

When adding a route prefix, update `src/routes/route.ts`, run `pnpm run waf:sync`,
and include the generated `config/waf-allowlist.json` diff. If `pnpm run waf:check`
reports drift, regenerate and review the allowlist. Authentication and permissions
still belong to route middleware; the allowlist only covers route prefixes.

Generating the allowlist is local. To apply it remotely, prepare `.waf.vars` from
`.waf.vars.example` and run `pnpm run waf:sync:apply`. For deployment integration,
use `WAF_SYNC=1 pnpm run deploy` with the setup in [operations](operations.md).
