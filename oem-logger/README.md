# OEM Error Logger

`oem-errogger` is the Tail Worker for `oem-backend`. It writes only failed
invocations to the dedicated `OEM-ERR` D1 database.

An invocation is retained when it has an HTTP status of 500 or higher, a
non-`ok` outcome, an unhandled exception, or a `console.error` entry. The full
redacted Cloudflare TailItem is stored in `payload_json`; common lookup fields
are also stored as columns.

An isolated `Network connection lost.` exception on a locator WebSocket that
ran for at least five minutes is treated as a routine transport disconnect.
Short-lived failures, 5xx responses, and traces with other errors are retained.

Successful invocations only run the in-memory error predicate. They are not
serialized and do not access D1.

## Retention

The logger runs a daily Cron Trigger at 03:17 UTC and deletes rows older than
120 days based on `event_timestamp_ms`.

## Deployment and investigation

See [operations](../docs/operations.md#logger-deployment) for deployment and
[contribution checks](../CONTRIBUTING.md#checks) during development.

Query recent errors:

```sh
pnpm exec wrangler d1 execute OEM_ERR --remote \
  --config oem-logger/wrangler.toml \
  --command "SELECT datetime(event_timestamp_ms / 1000, 'unixepoch') AS occurred_at, status, outcome, method, url, ray_id FROM worker_errors ORDER BY event_timestamp_ms DESC LIMIT 50"
```

Look up a Cloudflare Ray ID:

```sh
pnpm exec wrangler d1 execute OEM_ERR --remote \
  --config oem-logger/wrangler.toml \
  --command "SELECT * FROM worker_errors WHERE ray_id = 'RAY_ID' ORDER BY event_timestamp_ms DESC"
```
