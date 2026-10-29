"""Synthetic, offline 0038 backup/restore rehearsal. Never accepts a target database.

Creates a NEW evidence directory, retains SQLite files and emits a JSON receipt.
Native D1/installed Wrangler executor proof remains in scripts/worker-tests/.
"""

import argparse
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3

from preflight import inspect

ROOT = Path(__file__).resolve().parents[2]
DEPENDENCIES = [
    "ugc_submission_upvotes", "ugc_submission_votes", "ugc_submission_flags",
    "notifications", "notification_messages", "notification_counters",
]


def connect(path):
    db = sqlite3.connect(path, isolation_level=None)
    db.execute("PRAGMA foreign_keys=ON")
    return db


def state(db):
    schema = db.execute("SELECT type,name,sql FROM sqlite_schema ORDER BY name").fetchall()
    tables = db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").fetchall()
    return {"schema": schema, "rows": {
        name: sorted(db.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall(), key=repr)
        for (name,) in tables
    }}


def copy_database(source, path):
    destination = connect(path)
    try:
        source.backup(destination)
    finally:
        destination.close()


def verify_restore(backup, destination, expected):
    with closing(connect(backup)) as source:
        copy_database(source, destination)
    restored = connect(destination)
    try:
        assert state(restored) == expected, "restored schema and every table must match backup"
        assert restored.execute("PRAGMA foreign_key_check").fetchall() == []
        assert restored.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    finally:
        restored.close()


def rehearse(directory):
    if not __debug__:
        raise RuntimeError("Run without Python -O: rehearsal assertions must be enabled")
    directory.mkdir(parents=True, exist_ok=False)
    # Reuse the frozen historical schema builder and representative ticket-13 seed.
    spec = importlib.util.spec_from_file_location(
        "legacy_builder", ROOT / "migration-candidates/ugc-snapshots/build_import.py"
    )
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    source = builder.current_database()
    try:
        source.executescript((ROOT / "src/test/fixtures/ugcSnapshotLegacy.sql").read_text())
        copy_database(source, directory / "legacy.sqlite")
    finally:
        source.close()
    legacy = connect(directory / "legacy.sqlite")
    try:
        before = state(legacy)
        legacy_status_counts = dict(legacy.execute("SELECT status,count(*) FROM ugc_submissions GROUP BY status"))
        active_counts = {table: legacy.execute(f"SELECT count(*) FROM {table} WHERE active=1").fetchone()[0]
                         for table in DEPENDENCIES[:3]}
        copy_database(legacy, directory / "backup.sqlite")
        copy_database(legacy, directory / "working.sqlite")
    finally:
        legacy.close()
    preflight = inspect(directory / "backup.sqlite")
    assert preflight["clear"], preflight
    migration_path = ROOT / "migrations/0038_ugc_snapshots.sql"
    migration = migration_path.read_text()
    working = connect(directory / "working.sqlite")
    try:
        # Fail after all five dependencies have been detached, before replacement.
        marker = "DROP TABLE notifications;"
        assert migration.count(marker) == 1
        failing = migration.replace(marker, marker + "\nINSERT INTO _ugc_check VALUES ('injected_after_detach',0);")
        try:
            working.executescript("BEGIN;\n" + failing + "\nCOMMIT;")
        except sqlite3.IntegrityError:
            working.rollback()
        else:
            raise AssertionError("injected failure unexpectedly committed")
        assert state(working) == before, "failure must restore every table and schema object"
        verify_restore(directory / "backup.sqlite", directory / "restored-before-commit.sqlite", before)

        working.executescript("BEGIN;\n" + migration + "\nCOMMIT;")
        committed = state(working)
        review_status_counts = dict(working.execute("SELECT review_status,count(*) FROM ugc_snapshots GROUP BY review_status"))
        for table in DEPENDENCIES:
            assert committed["rows"][table] == before["rows"][table], table
        assert len(committed["rows"]["ugc_submissions"]) == len(committed["rows"]["ugc_snapshots"]) == 10
        # The expected mapping comes from the agreed business rules, independently of import SQL.
        statuses = {"active": "approved", "flagged": "approved", "remove_request": "approved",
                    "stale": "unknown", "pending_openai": "pending_openai", "pending_audit": "pending_audit"}
        with closing(connect(directory / "backup.sqlite")) as backup:
            backup.row_factory = sqlite3.Row
            originals = [dict(row) for row in backup.execute("SELECT * FROM ugc_submissions ORDER BY id")]
        working.row_factory = sqlite3.Row
        for original in originals:
            submission = dict(working.execute("SELECT * FROM ugc_submissions WHERE id=?", (original["id"],)).fetchone())
            snapshot = dict(working.execute("SELECT * FROM ugc_snapshots WHERE submission_id=?", (original["id"],)).fetchone())
            for field in ["id", "kind", "poi_id", "poi_hash", "poi_type", "user_id", "parent_id",
                          "comment_depth", "created_at", "updated_at"]:
                assert submission[field] == original[field], (original["id"], field)
            assert submission["revision"] == snapshot["revision"] == 1
            assert all(submission[field] is None for field in ["author_deleted_at", "admin_deleted_at", "admin_deleted_by"])
            for field in ["kind", "content", "file_path", "mime_type", "size_bytes", "moderation_queued_at", "created_at"]:
                assert snapshot[field] == original[field], (original["id"], field)
            assert snapshot["id"] == original["snapshot_id"]
            assert snapshot["creator_user_id"] == original["user_id"]
            assert snapshot["review_status"] == statuses[original["status"]]
        assert not committed["rows"]["ugc_snapshots_review_audit"]
        assert working.execute("PRAGMA foreign_key_check").fetchall() == []
        assert not working.execute("SELECT name FROM sqlite_schema WHERE name GLOB '_ugc_*' OR name GLOB '_notification*backup'").fetchall()
        working.close()
        working = None
        # Reopen to prove the success is durable; keep all writers stopped throughout.
        reopened = connect(directory / "working.sqlite")
        try:
            assert state(reopened) == committed
        finally:
            reopened.close()
        verify_restore(directory / "backup.sqlite", directory / "restored-after-commit.sqlite", before)
    finally:
        if working is not None:
            working.close()
    receipt = {
        "scope": "synthetic offline SQLite; target backup, maintenance and deployment unperformed",
        "migration_sha256": hashlib.sha256(migration_path.read_bytes()).hexdigest(),
        "preflight": preflight,
        "submission_count": len(committed["rows"]["ugc_submissions"]),
        "snapshot_count": len(committed["rows"]["ugc_snapshots"]),
        "legacy_status_counts": legacy_status_counts,
        "review_status_counts": review_status_counts,
        "retained_row_counts": {table: len(committed["rows"][table]) for table in DEPENDENCIES},
        "retained_active_counts": active_counts,
        "passed": ["backup reopen and full restore before commit", "failure after five dependencies detached rolls back",
                   "canonical 0038 committed and reopened", "five dependencies and counters identical",
                   "all identities/content/files/state/times preserved by agreed mapping", "FK clean and temporary tables removed",
                   "backup restore after commit with no new writes"],
        "files_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(directory.glob("*.sqlite"))},
    }
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path, help="new local evidence directory")
    print(json.dumps(rehearse(parser.parse_args().output_dir), indent=2))
