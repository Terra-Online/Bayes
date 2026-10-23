# OEM logging

| Pipeline | Destination | Retention |
| --- | --- | --- |
| `oem-backend` → Tail Worker `oem-errogger` | D1 `OEM-ERR`, table `worker_errors` | 120 days |
| `oem-backend` → Logpush | Private R2 bucket `opendfieldmap-log` | 180 days, once the lifecycle is applied |

## Tail errors

The Tail Worker writes one row per failed invocation. `error_reasons_json`
records matching categories: `http_5xx`, `runtime_exception`, `console_error`,
and `outcome_failure`. The original redacted TailItem is kept in `payload_json`.

- Successful invocations do not access D1 or serialize their payloads.
- Pure cancellations, including an isolated `Network connection lost.` exception,
  are ignored. Canceled invocations with 5xx responses, error logs, or other
  exceptions are retained.
- An isolated network disconnect on `/locator/position-stream` after at least
  five minutes is ignored unless the invocation also has a 5xx response or error log.

Daily cleanup runs at 03:17 UTC, using `event_timestamp_ms`. Apply migration 0002
before deploying the updated logger; the deployment wrapper handles this order.
Existing rows retain their payloads and have an empty category array.

Query recent errors, adding a `WHERE ray_id = 'RAY_ID'` filter when needed:

```sh
pnpm exec wrangler d1 execute OEM_ERR --remote \
  --config oem-logger/wrangler.toml \
  --command "SELECT datetime(event_timestamp_ms / 1000, 'unixepoch') AS occurred_at, status, outcome, error_reasons_json, method, url, ray_id FROM worker_errors ORDER BY event_timestamp_ms DESC LIMIT 50"
```

## Logpush archive

[`config/logpush.json`](../config/logpush.json) selects all `oem-backend`
invocations without sampling, writing compressed NDJSON to
`opendfieldmap-log/workers/oem-backend/{DATE}`. CPU/wall time, event context,
entrypoint, deployment version, logs, and exceptions are included.

`logpush = true` in Wrangler enables the producer only. The destination job and
180-day lifecycle require separate configuration; no Worker R2 binding is needed.
Existing Observability persistence and 5% trace sampling remain independent.
Logpush delivers batches automatically, typically around once a minute, with
possibly multiple files per minute; batch settings do not guarantee delivery latency.

Each executed HTTP handler adds one `oem.request` console entry. Its fields are
defined in [`requestTelemetry.ts`](../src/lib/requestTelemetry.ts):

| Data | Interpretation |
| --- | --- |
| `responseReadyMs` | Server time until returning a Response, excluding body transfer, socket lifetime, and waiting for background tasks |
| Native `CPUTimeMs` / `WallTimeMs` | Runtime measurements; wall time may include work after response readiness |
| IP, country, region, city, ASN | Client source metadata; an IP can represent a proxy or another Worker |
| `colo` | Cloudflare processing location, distinct from client geography |
| `source`, `entrypoint`, `protocol` | Separate edge/unknown calls, internal cache execution, and WebSocket handshakes |
| `rayId`, `requestId` | Correlation identifiers, when available |

Internal cache reads have null client fields; cache hits may skip handler execution.
These counts describe invocations, not users or page views. WAF-blocked requests
that never execute the Worker are outside this dataset.

Added metadata omits queries, cookies, authorization headers, and request/response
bodies. It adds one Observability log event per executed handler. Native events
and existing application logs use Cloudflare's own redaction. Logpush caps logs
and exceptions at 16,384 combined characters, so large invocations can lose the
metadata entry; missing duration is not zero.

## Configuration and activation

Preview locally, without credentials or network access:

```sh
pnpm run logpush:plan
```

When ready to enable remote delivery:

1. Keep `opendfieldmap-log` private: disable its r2.dev URL and custom domains.
2. Copy `.logpush.vars.example` to ignored `.logpush.vars`. Supply an account API
   token with Logs Write and R2 Storage Write, plus bucket-scoped R2 Object Read &
   Write credentials. Keep these out of Worker secrets and `.dev.vars`.
3. Run `pnpm run logpush:status` for read-only inspection, then
   `pnpm run logpush:apply` to configure the job and lifecycle. The tool never
   creates a bucket, preserves unrelated lifecycle rules, and reuses the matching
   job. Destination validation may upload a test object; changes are not atomic.
4. Deploy the backend and logger, applying the logger migration first.

Provisioning is not part of builds or deployment. Credentials and raw API error
bodies are not printed. `--vars-file /absolute/path` supports external credentials.
Logpush starts with new data and does not backfill earlier logs or D1 records.

## Verification and analysis

After activation, check `logpush:status` and the Logpush health dashboard for
enabled state, recent completion, and errors. Inspect normal traffic and an
existing real failure in R2; confirm CPU/wall time, request metadata, lifecycle,
and recent errors in D1. R2 expiry uses object age; D1 uses event time.

Download a daily prefix with an AWS CLI profile that has R2 read access:

```sh
aws --profile oem-archive --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  s3 cp s3://opendfieldmap-log/workers/oem-backend/YYYY-MM-DD/ \
  /tmp/oem-archive/YYYY-MM-DD/ --recursive
```

Use actual object prefixes from the bucket. Decompress selected gzip files, or
read them with DuckDB `read_json_auto(..., format = 'newline_delimited')`. Inspect
the actual `Logs[].Message` encoding before extracting request metadata.
Deduplicate retried records using invocation identity; Ray ID alone is not unique
across entrypoints, and some events lack a stable identifier.

Measure daily object count and compressed bytes to estimate monthly R2 writes
and 180-day storage. Logpush bills delivered invocation records; R2 bills storage
and operations separately. Observability persistence is an additional meter.
Delivery format, truncation rate, and actual costs require post-deployment samples.
