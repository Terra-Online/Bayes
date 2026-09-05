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

## Persistent Login

- `SESSION_TTL_SECONDS` controls both Better Auth sessions and their persistent HttpOnly cookies. The default is `15552000` seconds (180 days), with a one-day renewal threshold. Shorter overrides use an update threshold no greater than half their TTL.
- Production authentication cookies use CHIPS: `Secure; HttpOnly; SameSite=None; Partitioned; Path=/`, without a `Domain` attribute. The new `__Secure-oem-chips.*` names avoid collisions with legacy unpartitioned `__Secure-better-auth.*` cookies. Local HTTP development retains the original non-partitioned cookie configuration.
- `GET /auth/v1/session` renews a valid, eligible session and forwards every renewal `Set-Cookie` header to the browser. Ordinary identity lookups disable refresh, so they cannot extend the database lifetime while silently discarding the browser cookie update.
- Atlos validates on startup and after login. There is no periodic session polling. For a healthy signed-in session, returning to a visible/online page or interacting with it triggers another check only after 24 hours; confirmed guests do not perform automatic checks. Failed checks retry on subsequent activity/resume events, at least one minute apart, and requests time out after 15 seconds. Network errors, 429 and 5xx responses do not clear an existing user. A confirmed session 401 does. Business requests that return 401 request earlier, throttled revalidation without replaying mutations.
- Users returning about every 40 days receive another 180-day window on eligible visits. This is a sliding lifetime, not a forced logout every 180 days. Expired or revoked sessions are not restored, and clearing/blocking cookies still prevents persistent login.
- Migration is silent when the browser can still send a valid legacy cookie. Only when the new cookie is absent, the server verifies the legacy signature/session and issues a partitioned cookie for the same session. Atlos makes one additional request to confirm that the browser retained it; only after confirmation are legacy cookies retired. An invalid new cookie never falls back to a different old account. Sign-out revokes the active session and clears both cookie generations. No database migration, mass session revocation, or secret rotation is needed.
- Both `.cn` and `.org` production frontends keep their authentication and Bayes business requests on `https://api.opendfieldmap.org`; production `VITE_AUTH_BASE` overrides do not redirect these requests elsewhere. No CN reverse proxy is required for this configuration. Browsers must support partitioned cookies; this is not a guarantee against browser data deletion, expiry, or all privacy policies. A legacy cookie already blocked, deleted, expired, or revoked cannot be silently migrated.
- OAuth provider callbacks remain on the existing `.org` API. The social sign-in response sets a ten-minute partitioned HttpOnly browser-proof cookie and binds its SHA-256 challenge to the callback. A callback produces a two-minute, frontend-origin-bound, single-use exchange code. The frontend exchanges it from its own top-level site; the backend requires the original browser proof, atomically consumes the code, and sets the session cookie in that site's partition. The exchange JSON contains no session token. Atlos verifies the cookie and account identity before reporting success. This protects the exchange against replay and login CSRF without depending on cookies from the callback's different partition.
- Deploy both Bayes and Atlos and set the deployed `SESSION_TTL_SECONDS` to `15552000`; stale overrides still take precedence. Keep the existing auth secret and database. Existing valid sessions can migrate without entering credentials. OAuth flows already in progress across deployment may need to be restarted because the exchange protocol now requires a browser proof.

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
- DISCORD_MODERATION_WEBHOOK_URL (optional secret; moderation webhook delivery is disabled when unset)
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

## Reliability and incident follow-up

- Apply `migrations/0032_visible_comment_parent_index.sql` through the normal D1 migration process before deploying this backend. It adds a partial index for visible comment replies; it does not modify user/session data. Public comment queries aggregate reactions only for the requested roots/replies. Marker lists, reply-root lists, and notification read-id lists use a single bound JSON array rather than exceeding D1's 100-parameter limit.
- Public image/comment cache fanout is limited to eight active reads per request, including response-body consumption. Cache-miss SQL batches are serialized per isolate/database/loader configuration. These are local limits, not a global D1 capacity guarantee. Failed/partial reads are not cached; failures are never converted into successful empty results.
- Recognized D1 overload/internal errors and Durable Object lifecycle failures return `503`, `Retry-After: 5`, and `Cache-Control: private, no-store`. The backend does not blindly retry database writes or overloaded objects. Clients should use jittered backoff; progress retries must preserve the mutation id and payload when delivery is uncertain.
- Progress revision conflicts remain `409` with the existing cloud snapshot. Conflict telemetry now includes request id, mutation id, base revision, manifest hash, stage, and status without treating an expected conflict as a server exception. A client must reconcile against the returned cloud state, not repeatedly resend a stale patch or change the mutation id of an uncertain write.
- Notification upgrade rejections are caught before returning to the Worker runtime. Snapshot reads finish before a socket is accepted; reconnecting the same client closes its previous connection, and close handshakes are completed. Live fanout is best-effort after notification persistence: failures remain error-logged but do not replay committed moderation operations. Notification lists/unread counts remain authoritative; this is not guaranteed live delivery during a deployment/reset.
- Locator upstream reconnection uses exponential backoff with jitter (initially 0.5–1 second, capped at 15–30 seconds), resets only after at least 60 seconds of subscribed uptime, and stops on client disconnect. It cannot prevent upstream outages or platform connection termination.
- The demo R2 writer requires both a locally configured backend URL and a local request URL. Its request header alone no longer enables writes in production. The hard-coded Discord webhook fallback has been removed: rotate the previously embedded webhook at its provider, then configure the replacement via `DISCORD_MODERATION_WEBHOOK_URL`; deleting it from source does not revoke the old credential or remove it from Git history.

The OEM_ERR summary for 2026-08-25 through 2026-09-05 identifies symptoms, not a proven incident root cause. Correlate the 2026-09-05 06:44–06:49 Beijing window (2026-09-04 22:44–22:49 UTC) with D1 query duration/rows scanned, database queue depth, Worker resource limits, and deployment/DO reset timestamps. Track `503` alongside `500`, plus conflict frequency and reconnect rates, so a status-code correction is not mistaken for a recovered service. No production database changes or deployments are performed by these code changes.

## Query volume and 12-hour karma evaluation

- The supplied expensive-query list's largest entry is **outbox health**, not karma evaluation: the unconditional aggregate over `progress_stats_outbox` scanned about 1.55 billion rows across 43,278 executions. Health now filters to pending/retry/blocked events and runs every five minutes. Dispatch/recovery still runs every minute, and the existing 30-day mutation / 45-day processed-outbox retention remains unchanged.
- Apply `migrations/0033_query_efficiency_indexes.sql` before deploying these changes. Its indexes cover active outbox health, unprocessed predecessors, processed-record cleanup, user-scoped UGC reads, and eligible karma users. It replaces the full-history outbox user-order index with a covering partial index; no event, account, or session data is removed. SQL-plan regression tests use 20,000 retained processed events to verify that the optimized paths do not walk that history.
- `ensureUserProfile` reads the current profile rather than issuing an unconditional update for every authenticated request. Unchanged email plus activity within the last hour needs no write. The timestamp update has a database-side guard against concurrent duplicate writes; an email change is persisted immediately. Activity timestamps now have approximately one-hour precision. Auth/session validation and role/karma cache lifetimes are not extended.
- Karma starts a complete sweep every **12 hours**, independently of surge mode and the legacy `karmaConfig.evaluation.intervalSeconds`. A sweep processes up to the configured batch size (capped at 1,000 users) per cron invocation, continuing on later minute ticks until complete. A 45-second soft work budget checkpoints partial pages. Long-running sweeps are not discarded when the next interval arrives. Redis and cron availability are prerequisites; failures delay processing rather than pretending an evaluation completed.
- A versioned Redis cycle cursor replaces the previous dirty-set sampling and expiring last-run marker. A renewable 180-second owner-token lease prevents concurrent cron/manual runs; checkpoint and release operations compare the owner token atomically. Failed batches leave the cursor unchanged for retry. During the remainder of a completed 12-hour cycle, the scheduler checks Redis and performs **no karma D1 queries**. Moderation still records points immediately, but no longer writes a dirty-user set that the complete sweep does not need.
- Every eligible user is evaluated, including inactive users whose karma can decay. Robots and the existing permanently retained karma-5 tier are skipped. Image aggregates are restricted to selected users; only changed karma values are written, in batches, with an optimistic guard against replacing a concurrently changed karma/role. `dirtySelected` remains zero for API compatibility; `cycleComplete` and `nextRunAt` expose sweep progress. Explicit admin `/moderation/v1/karma/run-once` calls can start an early cycle or continue the active one under the same lease.
- Deploy the **tail logger separately** to activate the `outcome === "canceled"` exclusion. Those events are discarded before JSON serialization or D1 writes, even if they include error logs/exceptions. Other outcomes, including `loadShed` and `responseStreamDisconnected`, remain eligible for logging. This affects new records only; historical canceled records are not deleted.

After deployment, compare D1 query executions, rows read, and rows written separately. Expect outbox health executions to drop by roughly 80% from the cadence change alone, with a further reduction in rows scanned from the active-only index. Compare profile writes per active user and confirm that each karma cycle reaches `cycleComplete: true`; low query counts alone do not prove that every user was evaluated.

### UGC read efficiency

- Apply `migrations/0034_pending_comment_overlay_index.sql` alongside the preceding migrations before rollout. This adds a partial index for pending comments only, so the viewer overlay does not walk a user's approved comment history. Approval/removal updates index membership without a separate cache write.
- Public comment cold reads now select roots and replies in one SQL statement rather than two when replies are requested. Candidate sets are reused, reply counts use direct visible children, and reaction/author lookups are limited to selected comments. Root ranking, reply ordering, per-parent limits, and hidden-ancestor exclusion remain unchanged.
- Viewer reactions are queried only for IDs actually returned by the public cache, including nested replies, while retaining user, marker, kind, visibility, and image-scope checks. Empty public images require zero reaction statements; empty public comments require one pending-comment statement instead of two overlay statements. These counts exclude authentication and public-cache miss queries.
- Translation visibility is still checked against D1 on every request, but reads only comment ID/text without joining users. Equal normalized text shares cache lookups within the request, including misses. An auto-source KV pointer with a missing text value falls back directly to the target-language D1 lookup instead of also doing an exact-key D1 lookup. Database failures still propagate rather than triggering paid translation fallback.
- Existing public cache keys and TTLs are retained, avoiding a forced cache-wide cold start. Viewer responses remain `private, no-store`, and preserve partial-response metadata when some markers fail. Pending content and user reactions are not placed in the public cache.

Query-count and index-plan regression tests run locally against SQLite, including 100 markers, more than 100 reply roots, and 10,000 approved historical comments. The initial fixtures did not include all competing production indexes, so those passing tests alone missed the access-path regression documented below. They do not measure production cache-hit rates, D1 billing, or Cloudflare cache propagation.

### D1 access-path regression correction (2026-09-05)

A read-only production inspection confirmed that migrations 0032–0034 were present, but no `sqlite_stat*` tables were present. The planner selected broad `kind`/`active` indexes despite ID-scoped predicates, reversed the selected-comment join into a submission scan, and scanned the selected-user CTE once per image in karma aggregation. Fewer SQL statements did not mean fewer rows read.

- Comment reads now constrain parent traversal and direct-child counts to `idx_ugc_visible_comment_parent`, and votes to the existing submission-first primary-key index. The selected comment IDs drive the final row lookups through `CROSS JOIN`, not the other way around.
- Karma aggregation starts from the selected users and uses `idx_ugc_user_kind_poi_created` for each user's images. The complete 12-hour evaluation cycle, lease, checkpoints, scoring rules, and conditional writes are unchanged.
- Pending/user lists, viewer overlays, translation visibility, and image vote aggregation similarly select their existing scope/ID-first indexes. This adds no index, schema migration, periodic `ANALYZE`, or cache invalidation. The previously required migrations must still be applied before deploying. Primary-key index names and access-path constraints must be rechecked if these tables are rebuilt in a future migration.
- Regression fixtures now include competing production indexes and unrelated history without running `ANALYZE`. Tests require equality-bound access paths, not merely the presence of an index name or a `SEARCH` plan node.

A limited same-parameter comparison on the production D1 database at approximately **2026-09-05 15:39 UTC / 23:39 Asia/Shanghai** returned identical rows for each pair, with `rows_written = 0` throughout:

| Read-only sample | Before correction: rows read | After correction: rows read |
| --- | ---: | ---: |
| Empty comment marker | 12,653 | 13 |
| One populated marker, one result row | 14,124 | 28 |
| Karma image aggregation for the same 90 users | 510,390 | 488 |

These are individual database query measurements, not an estimate of the reduction in total traffic or billing. The supplied report mixes old and new SQL, including the old unfiltered outbox-health query. Compare matching post-deployment windows and separate executions, rows read per execution, and one-time rollout activity before drawing workload-wide conclusions. The diagnostic comparison does not deploy the corrected Worker or modify production data.

### Map progress acknowledgements

Map progress state, successful sync responses, and revision-conflict snapshots now include `retainedPointIds`: acknowledged backups of marked IDs outside the requesting client's current marker index. The existing `pointIds` field still contains only current visible IDs. Removed IDs from an older stored bitmap are included in the retained acknowledgement; retained IDs that are now in the current index are not used to claim a visible bitmap mark exists. This reads existing user progress data and requires no additional D1 query or schema migration.

Deploy the backend before the matching frontend changes. The frontend persists retained acknowledgements in its sync baseline and uploads only previously unacknowledged legacy IDs. The profile shows `sync.already` when current point sets match and all local legacy IDs are acknowledged, instead of comparing a full local list against a visible-only cloud list. A change followed by an undo immediately returns to the synchronized state without waiting for the dirty timer. Normalization treats order, duplicate IDs, and whitespace consistently with the backend. Local edits arriving during a request remain pending; failed requests retain their idempotency key, and genuine revision conflicts are not bypassed.

Existing local point records and cloud retained backups are not deleted. Older clients can ignore the new field; the new client can infer acknowledgement of legacy IDs from its own successful request when talking to an older server, but skipping repeated legacy uploads across page reloads requires the new backend state response. A synchronized label describes the last acknowledged cloud baseline, not continuous real-time observation of other devices.
