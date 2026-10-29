# UGC snapshot cutover rehearsal and release gates

Ticket 14 is **partial, blocked for deployment** until the target evidence below
exists. Local synthetic backup/restore and native executor tests cannot accept the
target-data, maintenance or deployed-client criteria. No deployment is authorized
by this guide. There is deliberately no combined production cutover command.

The inner storage change is `migrations/0038_ugc_snapshots.sql`. It preserves the
submission identity and imports its current content as revision one. Existing
services own lifecycle policy; HTTP, queues and cron are outer entrypoints that
must agree on the same schema and version contract. This guide changes no business
rules and does not perform historical repairs.

## Run the offline checks

Python 3 standard library is sufficient. From the repository root:

```sh
python3 -m unittest discover -s scripts/ugc-cutover -p 'test_*.py'
python3 scripts/ugc-cutover/rehearse.py --output-dir /tmp/ugc-cutover-rehearsal
python3 scripts/ugc-cutover/preflight.py /tmp/ugc-cutover-rehearsal/backup.sqlite
```

The output directory must not exist. Rehearsal uses the frozen 0001–0037 schema
builder and existing representative legacy fixture, then executes the **canonical
0038 file** in a single SQLite transaction. It retains the source, backup, working
database, two restored copies and `receipt.json`. It does not accept target data,
use Wrangler configuration, connect to D1/R2 or install dependencies. Run Python
without `-O`; optimized execution is refused because assertions verify the proof.

The rehearsal checks every row/schema object after injected failure following
detachment of all five dependencies. It verifies a durable successful commit,
the five dependent tables (upvotes, votes, flags, notifications, notification
messages), unchanged unread counters, every retained identity/content/file/time
field, revision one, status mapping, empty audit, clean FK check and temporary
table removal. Both pre-commit and post-commit restores reopen the backup and
compare **every table and schema object**, including unrelated business tables.
There are no writes between successful migration and post-commit restore.

Reuse the native proof rather than inventing another D1 executor:

```sh
node --test scripts/worker-tests/test-ugc-snapshot-import.mjs scripts/worker-tests/test-ugc-migration-executor.mjs
```

These start isolated local Miniflare databases. The executor test invokes installed
Wrangler with `--local`, a temporary config/database ID/persistence directory, and
checks registration, repeat apply, immutable triggers and atomic late failure.
They require permission to bind localhost. SQLite backup proof does not prove
target D1 export/import, Time Travel or remote executor behavior.

## Inspect an actual offline target copy

Obtain an authorized, consistent target backup separately. Record target identity,
schema/migration history, time/bookmark, executor version, release SHAs and hashes
privately. Restore it into an isolated environment using the intended target
restore mechanism. A SQL dump must first be restored and verified by the operator;
the preflight intentionally accepts only an existing local SQLite database file:

```sh
python3 scripts/ugc-cutover/preflight.py /absolute/path/to/offline-target.sqlite > /tmp/ugc-target-preflight.json
```

Exit **0** means the listed offline data checks are clear, **1** means discrepancies
were listed, **2** means input/schema/read failure (including missing legacy tables
or a post-0038 schema). Retain the exit code with the report. No path defaults to
production. The command opens SQLite read-only and uses one read transaction.
It cannot migrate, approve, drop or rewrite rows. Reports contain identifiers;
keep target evidence private.

Checks list both pending comment stages, unknown/null legacy statuses, empty/null
or duplicate identities, duplicate snapshot IDs, missing authors, invalid comment
content, missing/empty image paths, invalid required structure, missing parent
links, all declared dependent/user foreign keys and SQLite integrity failures.
Parent links deliberately have no new self-FK; their report requires explicit
historical-data disposition rather than a silent repair. A nonempty file path
does not prove that the real R2 object exists. Target object inventory, metadata
and authenticated file checks remain separate release evidence. This is a data
preflight, not a complete schema-drift comparison or a maintenance lock.

Pending comments must be listed and the cutover stopped. Any legitimate review
must happen under the old system before restarting the pause/drain/backup process.
Never auto-approve, discard, rewrite unknown states or disable constraints to make
the migration pass. `active/flagged/remove_request` import as approved; `stale`
imports as unknown without inferred deletion/rejection; pending images retain
their phase. Old edit backups, notes and review events are intentionally lost.

## Maintenance gate and drain

Before scheduling release, assign an operator and record the **actual** mechanism,
test result and restoration action for every writer below. No universal maintenance
gate or drain controller is implemented in this ticket. Documentation does not
block an old Worker or a client with a cached page. Lack of an effective operational
gate is a release blocker.

| Writer | Required control and evidence |
| --- | --- |
| User comments/images, edits, author DELETE, reports, upvotes/votes/replies | Block ingress at the actual routed Worker/origin, including direct Worker URLs and old versions. `LOCK_UPLOAD_ENDPOINTS=true` is an existing route control; verify all write routes on the deployed old build and deny queued client retries. |
| Cor/manual review, run/run-once, warnings, test-image archival and karma actions | Block management ingress and old admin tabs; `LOCK_MODERATION_ENDPOINTS=true` is an existing route control. Verify authenticated mutations are denied, not just a disabled button. |
| `oem-moderation` consumer and retries/DLQ replay | Stop new production first; drain existing deliveries under the old schema, including provider calls and `waitUntil` work, then pause consumer dispatch. Record backlog, in-flight and retry state. Quarantine unresolved messages and keep replay disabled. |
| `oem-translation` and `oem-webhook`, retries/DLQs | Drain their chained producers and effects, then pause dispatch/replay. Translation writes DB/cache and can enqueue webhooks; an empty moderation queue alone is insufficient. |
| Cron and moderation backfill | Disable scheduled dispatch. `LOCK_SCHEDULED_JOBS=true` and `ENABLE_SCHEDULED_MODERATION=false` are useful partial controls; `runProgressRecovery` runs outside that lock. Stop/drain the whole scheduled entrypoint for whole-DB restore safety. |
| Demo sync, ad hoc backfills, repair/import scripts, operator SQL and CI jobs | Stop jobs and revoke/suspend their target write path for the window; record owners and verify no running process. `scripts/sync-demo-ugc.mjs` writes DB/R2/KV outside HTTP locks. |
| Other business writers | For a lossless whole-DB fallback also stop/drain auth/session/profile, progress/outbox/DO recovery, notification read/live actions and all other target writers. Record any deliberately continuing writes and their accepted potential loss. |

Allow a controlled old-schema drain while ingress/producers are blocked, then
pause consumers before snapshotting. If drain cannot complete or pending comments
remain, abort and resolve under the old release; do not migrate a moving target.
Record time, active requests/provider calls, outstanding `waitUntil` tasks, queue
backlogs/retries, scheduled/DO work and direct DB writers. There is no local proof
of these target observations. Verify the operational gate denies old user/admin
mutations, stop new dispatch, wait for in-flight work, then **preflight again on a
fresh consistent copy**. Take the final recoverable backup only once quiescent;
prove its restore and repeat preflight before mutation. A rehearsal backup taken
before drain is insufficient.

## Coordinated release sequence

Do not run `pnpm deploy` / `scripts/deploy-with-dev-vars.sh` for this cutover. It
applies remote D1 migrations **before** replacing the backend Worker and also
performs unrelated logger/secrets deployment. That ordering leaves old code on new
tables unless an independently verified maintenance gate holds. No deploy command
was executed for this ticket. A release operator must first rehearse the selected
target executor/restore procedure on the isolated actual target copy, including
atomic failure and migration registration. Obtain explicit release authorization
separately; keep all gates closed throughout the following steps.

1. Pin the final Bayes commit, Atlos `997daac7def9d0b052f21aeffc59d176d96b835e`
   and Cor `5e4a863684ac805eb0704d28a194fbdb1bf1261c`. Record build artifacts and
   deployment identities. The Bayes final SHA belongs in the release receipt, not
   a self-referential source constant. Verify actual deployment routing, auth,
   Access/cookies and configuration for these builds.
2. Complete the gate/drain/final backup/preflight above. Execute only canonical
   `0038_ugc_snapshots.sql` using the rehearsed executor's whole-migration
   transaction. Do not send SQL fragments independently or manually mark a failed
   migration applied. Keep the pre-mutation backup immutable.
3. Before opening any writer, compare target before/after rows using the same
   invariants as rehearsal, all five dependencies and counters. Verify audit empty,
   states, original IDs/times/content/files, revision one, foreign keys, migration
   registration and no `_ugc_*`/dependency backup tables. Stop on any difference.
4. Replace Bayes HTTP, queue and scheduled runtimes together, still gated. Prevent
   all old Worker versions from serving any writer or receiving queue/cron events.
   Replace Atlos and Cor, invalidate cached application bundles as required, and
   require stale tabs to refresh. Deployment/routing of these builds is unverified.
5. Verify cache isolation at **both** layers: Workers public-read keys use `/v3`,
   and KV uses `ugc:marker-comments:v3:{default,test,prod}:<hash>` and
   `ugc:marker-images:v3:{default,test,prod}:<hash>`. Old v2 payloads must never
   satisfy v3 reads. Check any fronting CDN/service-worker cache and cold/warm
   responses for `snapshotId`. v3 is an isolation namespace, not an instantaneous
   global purge. If an earlier candidate polluted v3, invalidate that data and
   verify propagation before reopening clients. On backup restore invalidate
   post-cutover v3 data too; never serve versions absent from the restored DB.
6. With user ingress still closed, restore **new** webhook consumer, then translation
   consumer, then moderation consumer, so downstream chains are ready. Keep all
   old consumer versions and DLQ replay disabled. Versioned old moderation jobs
   may use preserved imported snapshot IDs subject to current eligibility.
   Missing-version legacy moderation messages are ACKed/skipped/logged, never
   bound to the current frontier. Resume exact-version pending-image backfill
   only on the new scheduler after consumers are verified. Restore remaining cron
   and DO work deliberately; record the first new writes and changed rollback
   boundary. There is no promise of lossless backup fallback after this step.
7. Verify the gated release with operator-controlled probes, then open management
   and user ingress to compatible clients. Record first accepted write/time and
   monitor errors, queue retries and unread counts. New edit requests require
   `parentSnapshotId`; reports require `snapshotId`. Old missing-version requests
   fail 422, stale-version requests fail 409, retired recall/remove-request/unrecall
   POSTs fail 404. Handle refresh/conflict visibly without automatically retrying
   against a different version. These failures do not prevent an old backend
   Worker from attempting incompatible SQL; the operational routing gate must.

## Rollback decisions

Before transaction commit, failure must roll back schema, every dependency and
counter, and migration registration. Verify this with the intended target executor;
then keep/recover the old runtime and clients with matching old caches before
restoring old consumers, cron and ingress. A lost connection with unknown commit
outcome requires inspection while all gates remain closed.

After commit, **even with no new writes**, the old Worker cannot run against the
new schema. Stop new runtimes, restore the verified pre-cutover backup using the
rehearsed target restore mechanism, verify the entire restored DB and migration
history, isolate/invalidate new caches, restore matching old clients/backend,
then downstream consumers, moderation/backfill/cron, and finally user/admin ingress.
Do not run migrations automatically during restore. Reconcile/quarantine queued
messages and already delivered external effects before replay. SQLite rehearsal
proves this boundary locally with no intervening writes.

Once any new immutable snapshot, review, delete, interaction, notification or
other business write is accepted, a simple old-Worker rollback is unsafe. There
is no lossless reverse migration in this release. Prefer a forward fix while
gated, or obtain an explicitly approved loss/reconciliation plan before restoring.
Whole-database restore loses **all** business writes since backup, including
accounts/sessions/profiles, progress and notification reads, even when UGC ingress
stayed closed. DB restore cannot undo R2 objects, delivered mail/Discord/webhooks,
Redis/DO state or queue acknowledgements. Retain objects, pause orphan cleanup,
inventory external effects and reconcile them separately. Never promise that
restoring just UGC tables or rolling back a Worker version repairs this state.

## Release evidence still required

Keep these unchecked until actual target observations exist:

- [ ] Authorized actual target backup, predecessor-schema drift comparison,
      offline preflight, real object inventory and isolated target restore proof.
- [ ] Effective ingress/old-version/direct-writer gates, full pause/drain evidence,
      repeated quiescent preflight and final backup.
- [ ] Intended target executor success/failure/registration and restored database
      comparison against actual data, both rollback checkpoints rehearsed.
- [ ] Final Bayes/Atlos/Cor deployment identities, cache isolation, compatible
      clients and ordered consumer/backfill/cron restoration verified live.
- [ ] Deployed public/owner content selection, concurrent edit/report 409,
      missing-version 422, retired paths 404, review/delete race, exact moderation
      delivery, notification/counter dedupe and file authorization before 304/R2.
- [ ] Separate release authorization, named operator and rollback/loss decision.

Local entrypoint evidence comes from the existing HTTP/queue tests, native import
and Wrangler executor tests, authenticated actual Cor contract tests and mounted
Cor tests. These exercise the local contracts and storage behavior. They do not
establish real maintenance, deployed OAuth/cookies/Access, browser bundle freshness,
live cache propagation, provider/queue delivery or real R2 authorization.
