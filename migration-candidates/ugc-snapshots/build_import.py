"""Build a local SQL design draft from current repository schema and new DDL."""
from pathlib import Path
import os
import sqlite3

HERE = Path(__file__).resolve().parent
ROOT = (Path(os.environ['BAYES_REPO_ROOT']).resolve()
        if 'BAYES_REPO_ROOT' in os.environ else
        next(parent for parent in HERE.parents if (parent / 'migrations').is_dir()))


def statements(sql):
    buf = ''
    for line in sql.splitlines(True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                yield buf.strip()
            buf = ''
    if any(line.strip() and not line.lstrip().startswith('--') for line in buf.splitlines()):
        raise ValueError('Incomplete SQL statement')


def current_database():
    db = sqlite3.connect(':memory:', isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    # This experiment targets the agreed pre-redesign schema. Future migrations
    # must not silently change its historical source schema.
    files = sorted(file for file in (ROOT / 'migrations').glob('*.sql')
                   if file.name[:4].isdigit() and int(file.name[:4]) <= 37)
    if len(files) != 37 or files[-1].name != '0037_comment_source_length.sql':
        raise RuntimeError('Expected the complete repository migration baseline 0001..0037')
    for file in files:
        db.executescript('BEGIN;\n' + file.read_text() + '\nCOMMIT;')
    return db


def build():
    db = current_database()
    target = list(statements((HERE / 'core-schema.sql').read_text()))
    table_sql = [s for s in target if 'CREATE TABLE ' in s]
    later_sql = [s for s in target if 'CREATE TABLE ' not in s]
    reactions = ['ugc_submission_upvotes', 'ugc_submission_flags', 'ugc_submission_votes']
    detach = reactions + ['notification_messages', 'notifications']
    restore = reactions + ['notifications', 'notification_messages']
    chunks = [
        '-- DESIGN DRAFT ONLY. Requires a paused, drained UGC write/review pipeline.',
        '-- Execute the entire migration in one transaction; this file omits BEGIN/COMMIT.',
        '-- Generated from repository migrations 0001..0037, not a deployment data export.',
        'PRAGMA defer_foreign_keys=ON;',
        'CREATE TABLE _ugc_check (name TEXT, ok INTEGER NOT NULL CHECK (ok=1));',
        "INSERT INTO _ugc_check SELECT 'no_pending_comments', NOT EXISTS ("
        "SELECT 1 FROM ugc_submissions WHERE kind='comment' "
        "AND status IN ('pending_openai','pending_audit'));",
        "INSERT INTO _ugc_check SELECT 'non_null_ids', NOT EXISTS ("
        "SELECT 1 FROM ugc_submissions WHERE id IS NULL OR snapshot_id IS NULL);",
        'CREATE TABLE _ugc_source AS SELECT * FROM ugc_submissions;',
    ]
    for sql in table_sql:
        sql = sql.replace('CREATE TABLE ugc_submissions (', 'CREATE TABLE ugc_submissions_next (')
        sql = sql.replace('REFERENCES ugc_submissions(', 'REFERENCES ugc_submissions_next(')
        chunks.append(sql)
    chunks += [
        '''INSERT INTO ugc_submissions_next
  (id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,revision,
   created_at,updated_at)
SELECT id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,1,
       created_at,updated_at FROM _ugc_source;''',
        '''INSERT INTO ugc_snapshots
  (id,submission_id,kind,revision,content,file_path,mime_type,size_bytes,
   review_status,moderation_queued_at,creator_user_id,created_at)
SELECT snapshot_id,id,kind,1,content,file_path,mime_type,size_bytes,
       CASE
         WHEN status IN ('active','flagged','remove_request') THEN 'approved'
         WHEN status IN ('pending_openai','pending_audit') THEN status
         ELSE 'unknown'
       END,
       moderation_queued_at,user_id,created_at
FROM _ugc_source;''',
    ]
    for name in detach:
        chunks += [f'CREATE TABLE _{name}_backup AS SELECT * FROM {name};', f'DROP TABLE {name};']
    chunks += [
        'DROP TABLE ugc_review_events;',
        'DROP TABLE ugc_submissions;',
        'ALTER TABLE ugc_submissions_next RENAME TO ugc_submissions;',
    ]
    for name in restore:
        objects = db.execute(
            "SELECT type,sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL "
            "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
            (name,),
        ).fetchall()
        for row in objects:
            if row['type']=='table':
                chunks.append(row['sql'] + ';')
        chunks += [
            f'INSERT INTO {name} SELECT * FROM _{name}_backup;',
            f"INSERT INTO _ugc_check SELECT '{name}_same', "
            f'NOT EXISTS (SELECT * FROM {name} EXCEPT SELECT * FROM _{name}_backup) '
            f'AND NOT EXISTS (SELECT * FROM _{name}_backup EXCEPT SELECT * FROM {name});',
            f'DROP TABLE _{name}_backup;',
        ]
        # Restore counter triggers only after copying notification rows, so the
        # retained counters are not incremented a second time by the import.
        for row in objects:
            if row['type']!='table':
                chunks.append(row['sql'] + ';')
    chunks += later_sql
    chunks += [
        "INSERT INTO _ugc_check SELECT 'one_snapshot_per_submission', "
        '(SELECT COUNT(*) FROM ugc_submissions)=(SELECT COUNT(*) FROM _ugc_source) '
        'AND (SELECT COUNT(*) FROM ugc_snapshots)=(SELECT COUNT(*) FROM _ugc_source);',
        '''INSERT INTO _ugc_check SELECT 'content_and_identity_preserved', NOT EXISTS (
  SELECT x.id FROM _ugc_source x
  LEFT JOIN ugc_submissions s ON s.id=x.id
  LEFT JOIN ugc_snapshots r ON r.id=x.snapshot_id AND r.submission_id=x.id
  WHERE s.id IS NULL OR r.id IS NULL OR s.revision<>1 OR r.revision<>1
    OR s.user_id IS NOT x.user_id OR s.parent_id IS NOT x.parent_id
    OR s.comment_depth IS NOT x.comment_depth
    OR s.poi_id IS NOT x.poi_id OR s.poi_hash IS NOT x.poi_hash OR s.poi_type IS NOT x.poi_type
    OR s.created_at IS NOT x.created_at OR s.updated_at IS NOT x.updated_at
    OR r.content IS NOT x.content OR r.file_path IS NOT x.file_path
    OR r.mime_type IS NOT x.mime_type OR r.size_bytes IS NOT x.size_bytes
    OR r.creator_user_id IS NOT x.user_id OR r.created_at IS NOT x.created_at
    OR s.author_deleted_at IS NOT NULL OR s.admin_deleted_at IS NOT NULL
);''',
        "INSERT INTO _ugc_check SELECT 'empty_new_audit', NOT EXISTS (SELECT 1 FROM ugc_snapshots_review_audit);",
        'DROP TABLE _ugc_source;',
        'DROP TABLE _ugc_check;',
        '-- Keep deferral enabled until commit; foreign keys must then be valid.',
    ]
    (HERE / 'import-current.sql').write_text('\n\n'.join(chunks) + '\n')
    db.close()


if __name__ == '__main__':
    build()
    print('Generated import-current.sql from the current 37-migration baseline.')
