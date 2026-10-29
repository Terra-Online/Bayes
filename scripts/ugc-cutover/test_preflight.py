"""Exercise the offline command against historical data, including damaged exports."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "legacy_builder", ROOT / "migration-candidates/ugc-snapshots/build_import.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class OfflinePreflight(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ugc-preflight-")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "legacy.sqlite"
        source = builder.current_database()
        source.executescript((ROOT / "src/test/fixtures/ugcSnapshotLegacy.sql").read_text())
        with sqlite3.connect(self.path) as destination:
            source.backup(destination)
        source.close()

    def run_cli(self):
        before = self.path.read_bytes()
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("preflight.py")), str(self.path)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(self.path.read_bytes(), before, "preflight must leave the input untouched")
        return result.returncode, json.loads(result.stdout)

    def test_clean_legacy_copy_and_all_blockers_are_reported_without_repair(self):
        code, report = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(report["submission_count"], 10)
        self.assertEqual(report["scope"], "offline legacy data only; not release approval")
        with sqlite3.connect(self.path) as db:
            # A damaged export may have been produced without enforced FK/CHECK constraints.
            db.execute("PRAGMA ignore_check_constraints=ON")
            db.execute("UPDATE ugc_submissions SET status='pending_openai' WHERE id='comment-active'")
            db.execute("UPDATE ugc_submissions SET status='pending_audit' WHERE id='comment-flagged'")
            db.execute("UPDATE ugc_submissions SET status='surprise' WHERE id='comment-stale'")
            db.execute("UPDATE ugc_submissions SET snapshot_id='' WHERE id='comment-remove_request'")
            db.execute("UPDATE ugc_submissions SET user_id='missing' WHERE id='image-active'")
            db.execute("UPDATE ugc_submissions SET content='   ' WHERE id='comment-stale'")
            db.execute("UPDATE ugc_submissions SET file_path=NULL WHERE id='image-stale'")
            db.execute("UPDATE notification_messages SET notification_id='missing'")
        code, report = self.run_cli()
        self.assertEqual(code, 1)
        issues = report["issues"]
        self.assertEqual({row["id"] for row in issues["pending_comments"]},
                         {"comment-active", "comment-flagged"})
        self.assertEqual(issues["unknown_statuses"], [{"id": "comment-stale", "status": "surprise"}])
        self.assertEqual(issues["invalid_identity"][0]["id"], "comment-remove_request")
        self.assertEqual(issues["missing_users"], [{"id": "image-active", "user_id": "missing"}])
        self.assertEqual(issues["invalid_comments"], [{"id": "comment-stale"}])
        self.assertEqual(issues["missing_image_paths"], [{"id": "image-stale"}])
        self.assertIn("notification_messages", {row["table"] for row in issues["foreign_keys"]})

    def test_missing_or_current_schema_is_an_input_error_and_never_creates_a_database(self):
        self.path.unlink()
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("preflight.py")), str(self.path)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.path.exists())
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE ugc_submissions(id TEXT, revision INTEGER)")
        code, report = self.run_cli()
        self.assertEqual(code, 2)
        self.assertIn("error", report)


if __name__ == "__main__":
    unittest.main()
