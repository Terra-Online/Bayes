"""Read-only legacy UGC diagnostics. Accepts one existing local SQLite file only.

Exit 0: data checks clear; 1: discrepancies; 2: input/schema/read failure.
No Cloudflare binding, credentials, remote mode, SQL execution input or repair path.
"""

import argparse
import json
from pathlib import Path
import sqlite3


def inspect(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")  # All checks see the same offline database snapshot.
        required = {"ugc_submissions", "users", "ugc_review_events", "ugc_submission_upvotes",
                    "ugc_submission_votes", "ugc_submission_flags", "notifications",
                    "notification_messages", "notification_counters"}
        present = {row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        if not required <= present:
            raise ValueError("Missing legacy tables: " + ", ".join(sorted(required - present)))

        def rows(sql):
            return [dict(row) for row in db.execute(sql)]

        issues = {
            "pending_comments": rows("""SELECT id,status FROM ugc_submissions
                WHERE kind='comment' AND status IN ('pending_openai','pending_audit') ORDER BY id"""),
            "unknown_statuses": rows("""SELECT id,status FROM ugc_submissions WHERE status IS NULL
                OR status NOT IN ('active','flagged','remove_request','stale','pending_openai','pending_audit')
                ORDER BY id"""),
            "invalid_identity": rows("""SELECT id,snapshot_id FROM ugc_submissions
                WHERE id IS NULL OR trim(id)='' OR snapshot_id IS NULL OR trim(snapshot_id)=''
                ORDER BY id"""),
            "duplicate_submission_ids": rows("""SELECT id,count(*) AS count FROM ugc_submissions
                GROUP BY id HAVING count(*)>1"""),
            "duplicate_snapshot_ids": rows("""SELECT snapshot_id,count(*) AS count FROM ugc_submissions
                GROUP BY snapshot_id HAVING count(*)>1"""),
            "missing_users": rows("""SELECT s.id,s.user_id FROM ugc_submissions s
                LEFT JOIN users u ON u.uid=s.user_id WHERE u.uid IS NULL ORDER BY s.id"""),
            "invalid_comments": rows("""SELECT id FROM ugc_submissions WHERE kind='comment'
                AND (content IS NULL OR length(trim(content))=0 OR length(content)>2250) ORDER BY id"""),
            "missing_image_paths": rows("""SELECT id FROM ugc_submissions WHERE kind='image'
                AND (file_path IS NULL OR trim(file_path)='') ORDER BY id"""),
            "invalid_structure": rows("""SELECT id FROM ugc_submissions
                WHERE kind IS NULL OR kind NOT IN ('comment','image')
                OR poi_id IS NULL OR poi_hash IS NULL OR poi_type IS NULL
                OR comment_depth IS NULL OR created_at IS NULL OR updated_at IS NULL ORDER BY id"""),
            # Parent links deliberately lack a new FK. Report historical damage for human disposition.
            "missing_parents": rows("""SELECT s.id,s.parent_id FROM ugc_submissions s
                LEFT JOIN ugc_submissions p ON p.id=s.parent_id
                WHERE s.parent_id IS NOT NULL AND p.id IS NULL ORDER BY s.id"""),
            "foreign_keys": rows("PRAGMA foreign_key_check"),
        }
        integrity = [row[0] for row in db.execute("PRAGMA integrity_check")]
        issues["integrity"] = [] if integrity == ["ok"] else integrity
        return {
            "scope": "offline legacy data only; not release approval",
            "submission_count": db.execute("SELECT count(*) FROM ugc_submissions").fetchone()[0],
            "issues": issues,
            "clear": not any(issues.values()),
        }
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="existing offline SQLite copy of pre-0038 data")
    args = parser.parse_args()
    try:
        report = inspect(args.database)
    except (OSError, ValueError, sqlite3.Error) as error:
        print(json.dumps({"clear": False, "error": str(error)}))
        return 2
    print(json.dumps(report, indent=2))
    return 0 if report["clear"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
