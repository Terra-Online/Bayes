# Operations and deployment

These commands are for maintainers or contributors operating their own installation.
Repository configuration names existing OEM resources; provision and configure
your own resources before deploying a fork.

## Resources and configuration

[`wrangler.toml`](../wrangler.toml) declares backend D1 (`DB`), R2 (`UGC_BUCKET`),
KV (`OEM_KV`), Durable Objects, the image transcoder, rate-limit bindings, mail,
three queue producers/consumers and their dead-letter queues, and a one-minute
cron. Logpush archives requests and errors to private R2. The legacy Tail Worker
and its `OEM_ERR` D1 are retained separately, with no backend Tail subscription.

Review custom domains, resource IDs/names, queue names,
and environment bindings for your installation.

Keep a deployment-specific secrets file separate from local values and inspect
which feature locks are intended to be active.

## Deployment sequence

The deployment script is [`scripts/deploy-with-dev-vars.sh`](../scripts/deploy-with-dev-vars.sh).
The normal command performs these steps:

1. Validate required secrets, including configured OAuth providers and email settings.
2. Run `pnpm run check`.
3. Refuse a `BETTER_AUTH_URL` containing localhost or `127.0.0.1`.
4. Optionally apply WAF rules.
5. Apply remote backend D1 migrations.
6. Deploy `oem-backend` with the secrets file and `--keep-vars`.

```sh
DEPLOY_VARS_FILE=.production.vars pnpm run deploy
```

The secrets file defaults to `.dev.vars` if `DEPLOY_VARS_FILE` is absent. A full
deployment updates only the backend Worker and its database; it is not an atomic release.
Review migration compatibility and recovery before running it.

`.production.vars` is an illustrative filename, not an automatically ignored
one. Keep it outside the checkout, or add your chosen filename to `.git/info/exclude`.

## Separate operations

| Command | Effect |
| --- | --- |
| `pnpm run db:migrate:local` | Apply backend migrations to local D1 |
| `pnpm run db:migrate:remote` | Apply backend migrations to remote D1 |
| `pnpm run deploy:raw` | Deploy backend directly, skipping wrapper checks and migrations |

### Legacy logger maintenance

The retained `oem-errogger` Worker and `OEM-ERR` database are outside normal
releases. Backend configuration explicitly clears Tail subscriptions on deployment;
new logs are archived by Logpush. Retaining the Worker also retains its existing
daily cleanup cron, so historical D1 rows still expire after 120 days.

For deliberate logger-only deployment, use `pnpm run deploy:logger`. The equivalent wrapper
invocation is `pnpm run deploy -- --logger-only`. Use `pnpm run logger:deploy:raw`
only when deliberately handling checks and migrations separately. Logger database
commands are defined in [package.json](../package.json).

## Runtime validation

After a release, verify the health endpoint and the affected feature with the
appropriate credentials. Check feature locks and queue consumers if mutations
succeed but background processing does not complete.

Use request IDs to correlate failures. The
[logging guide](../oem-logger/README.md) documents Logpush archives and legacy D1 queries.
For performance work, compare versioned windows with comparable traffic and
outcomes. CPU, wall time, SQL rows read, cache misses, and long-lived WebSockets
measure different things. An old observation report is not release acceptance.

## Notification inbox cutover (0040–0041)

This schema change requires a paused, drained deployment. Stop UGC mutations,
moderation consumers and notification traffic, wait for in-flight work, and back
up D1 before applying migrations. Apply 0040 and 0041 in order, deploy the matching
Worker code, then restore traffic. Old code cannot run against the new schema.
Do not roll back to the old Worker after applying the migrations; restore the
backup during a maintenance window if rollback is required.

Migration 0041 splits every saved message into an inbox entry, retains the parent
ID for its first child, inherits its read state, keeps cards without children,
and rebuilds unread counters. Unread totals can increase. It aborts on orphaned
messages or identity/deduplication collisions instead of silently losing history.
Source cutover positions exclude existing audits from fresh collection. Verify
`PRAGMA foreign_key_check`, inbox row counts against old message/card counts, and
unread counter sums before restoring traffic. Existing saved pagination cursors
should be discarded and clients should refresh from the first page.

No production migration or deployment is performed by the refactor itself.
