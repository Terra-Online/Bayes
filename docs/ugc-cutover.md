# UGC snapshot cutover

`migrations/0038_ugc_snapshots.sql` is the standalone migration from the legacy
submission schema. Execute the whole file in one transaction. Target data,
deployed D1 execution, backup restoration and coordinated deployment remain
unverified. Local tests do not establish release readiness.

## Data constraints

Pause UGC writes and reviews and drain in-flight work before taking the final
recoverable backup. Pending comments must be resolved under the old system;
the migration aborts if any remain. Inspect an authorized offline target copy
for schema drift, invalid identities/content/files, missing authors/parents,
foreign-key violations and unknown statuses. Record historical discrepancies
and their explicit disposition; do not silently repair data to pass migration.
Verify actual R2 objects separately from stored file paths.

The migration preserves submission IDs, imported snapshot IDs, owners, creation
times, current content/files, interactions and notification counters. It imports
one snapshot at revision one. `active`, `flagged` and `remove_request` become
approved; `stale` becomes unknown without inferred deletion or rejection facts.
Pending images retain their review phase. Old edit backups, review events and
notes are intentionally discarded.

## Release sequence

1. Pin the final Bayes build, Atlos `997daac7def9d0b052f21aeffc59d176d96b835e`
   and Cor `5e4a863684ac805eb0704d28a194fbdb1bf1261c`. Assign an operator and
   obtain release authorization. Verify routing, authentication and configuration.
2. Gate old and new user/admin writers, including direct Worker URLs, cached
   clients, demo sync, operator SQL and other background jobs. Existing upload,
   moderation and scheduled locks are partial controls; verify their actual scope.
   Stop new queue/cron producers, drain requests/provider calls/`waitUntil` work
   under the old schema, then pause consumers and retry/DLQ replay. A whole-DB
   restore also requires controlling unrelated business writers.
3. Take a fresh consistent target backup after drain. Prove restoration in an
   isolated environment. Rehearse the intended target executor's atomic success,
   failure and migration registration against that copy before target mutation.
4. Apply only canonical 0038 while gated. The normal deploy script applies remote
   migrations before replacing the Worker and performs unrelated deployment work;
   it is unsuitable for this coordinated cutover without separately verified gates.
   Compare retained rows, all dependent tables and counters, revision/status mapping,
   empty audit, foreign keys, migration registration and absence of temporary tables.
5. Replace Bayes HTTP, queue and scheduled runtimes together, then compatible Atlos
   and Cor builds. Prevent old runtimes and stale clients from writing. Verify both
   public-read `/v3` keys and `ugc:marker-{comments,images}:v3` KV namespaces,
   including cold/warm responses and `snapshotId`. Invalidate polluted v3 data.
6. Restore new webhook, translation and moderation consumers in that order.
   Quarantine old unversioned moderation work; it must never select the current
   frontier. Restore exact-version backfill, cron and other writers deliberately.
   Verify gated content/file access, edits/reports, notifications and queue delivery
   before reopening ingress. Missing versions return 422, stale versions 409 and
   retired recall/remove-request/unrecall POSTs 404.

## Rollback constraints

A failed transaction must leave schema, dependent rows, counters and migration
registration unchanged. Inspect uncertain commit outcomes while gates stay closed.
After a successful commit the old Worker requires restoration of the verified
pre-cutover backup, matching old runtimes/clients, and cache invalidation before
consumers and ingress resume. Do not automatically migrate the restored database.

There is no lossless reverse migration after new writes. Prefer a forward fix or
obtain an explicit loss/reconciliation decision. A whole-DB restore loses all
business writes since backup, including accounts, progress and notification reads.
It cannot undo R2 objects, delivered external messages, Redis/DO state or queue
acknowledgements. Retain objects and reconcile external effects and queued work.

Keep actual target observations and historical local proof reports privately.
Target preflight, effective gates/drain, executor/restore evidence, deployed build
identities, cache/client compatibility and release authorization remain required.
