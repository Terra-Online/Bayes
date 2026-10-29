# Migration 0038 reproduction inputs

The registered `migrations/0038_ugc_snapshots.sql` is the sole executable import.
Runtime fixtures and migration acceptance tests use that file. The former
`import-current.sql` candidate has been removed.

This directory retains the builder and its frozen schema input so reviewers can
reproduce the exact dependent table, index and trigger definitions from migrations
0001 through 0037. The builder deliberately excludes 0038 and later migrations.
Run `python3 migration-candidates/ugc-snapshots/build_import.py` from the repository
and inspect the diff. It writes the canonical numbered file, rather than another
candidate. It uses an in-memory SQLite database and does not contact D1.

The SQL requires one transaction through its final commit. The Node test executor
wraps 0038 explicitly; the native D1 executor uses Wrangler's trigger-aware splitter
and one batch. Earlier migrations retain their existing execution because several
toggle foreign key pragmas outside transactions. The isolated native executor test
also invokes the installed Wrangler `migrations apply --local` against temporary
storage, verifying committed registration, repeat application and late rollback.

Registration does not authorize an ordinary deployment. The deployment script
applies migrations before switching the Worker. Release requires a restore-tested
backup, maintenance covering user/admin/queue/cron writers, a drained pipeline,
target-data preflight and coordinated backend/client switching. Pending comments
in either review phase abort the import. Imported stale data becomes unknown, with
no invented review or deletion facts. Target backup, restore and deployed checks
belong to the separate cutover rehearsal.
