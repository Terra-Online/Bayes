# Operations and deployment

These commands are for maintainers or contributors operating their own installation.
Local development and pull request verification are described in
[development](development.md). Repository configuration names existing OEM
resources; provision and configure your own resources before deploying a fork.

## Resources and configuration

[`wrangler.toml`](../wrangler.toml) declares backend D1 (`DB`), R2 (`UGC_BUCKET`),
KV (`OEM_KV`), Durable Objects, the image transcoder, rate-limit bindings, mail,
three queue producers/consumers and their dead-letter queues, a Tail Worker,
and a one-minute cron. The logger has its own Wrangler config and `OEM_ERR` D1.

Review custom domains, resource IDs/names, queue names, Tail Worker service,
and environment bindings for your installation. Supply real game mappings and
a generated coverage manifest where those features are needed. Template data
is only a local starting point.

Secrets and common flags are listed in [development](development.md).
Keep a deployment-specific secrets file separate from local values and inspect
which feature locks are intended to be active.

## Deployment sequence

The deployment script is [`scripts/deploy-with-dev-vars.sh`](../scripts/deploy-with-dev-vars.sh).
The normal command performs these steps:

1. Validate required secrets, including configured OAuth providers and email settings.
2. Run `pnpm run check`.
3. Refuse a `BETTER_AUTH_URL` containing localhost or `127.0.0.1`.
4. Optionally apply WAF rules when `WAF_SYNC=1`.
5. Apply remote logger migrations and deploy `oem-errogger`.
6. Apply remote backend D1 migrations.
7. Deploy `oem-backend` with the secrets file and `--keep-vars`.

```sh
DEPLOY_VARS_FILE=.production.vars pnpm run deploy
```

The secrets file defaults to `.dev.vars` if `DEPLOY_VARS_FILE` is absent. A full
deployment updates both Workers and both databases; it is not an atomic release.
Review migration compatibility and recovery before running it.

`.production.vars` is an illustrative filename, not an automatically ignored
one. Keep it outside the checkout, or add your chosen filename to `.git/info/exclude`.

## Separate operations

| Command | Effect |
| --- | --- |
| `pnpm run db:migrate:local` | Apply backend migrations to local D1 |
| `pnpm run db:migrate:remote` | Apply backend migrations to remote D1 |
| `pnpm run deploy:logger` | Check, migrate, and deploy only the logger; no backend secrets file required |
| `pnpm run deploy:raw` | Deploy backend directly, skipping wrapper checks and migrations |
| `pnpm run logger:deploy:raw` | Deploy logger directly, skipping wrapper checks and migrations |
| `pnpm run waf:sync` | Regenerate the local allowlist from route mounts |
| `pnpm run waf:check` | Compare the local allowlist with route mounts |
| `pnpm run waf:sync:apply` | Regenerate and apply WAF rules using `.waf.vars` |

For WAF deployment integration, prepare `.waf.vars` from `.waf.vars.example`
and run `WAF_SYNC=1 pnpm run deploy`. The generated allowlist covers route
prefixes; route middleware still owns authentication and permissions.

## Runtime validation

After a release, verify the health endpoint and the affected feature with the
appropriate credentials. Check feature locks and queue consumers if mutations
succeed but background processing does not complete.

Use request IDs to correlate failures. The
[logger guide](../oem-logger/README.md) documents error retention and D1 queries.
For performance work, compare versioned windows with comparable traffic and
outcomes. CPU, wall time, SQL rows read, cache misses, and long-lived WebSockets
measure different things. An old observation report is not release acceptance.
