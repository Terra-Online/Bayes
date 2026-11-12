-- Pause and drain UGC writes. Execute this migration in one transaction.
DROP TRIGGER prevent_ugc_snapshots_review_audit_update;
DROP TRIGGER prevent_ugc_snapshots_review_audit_delete;
ALTER TABLE ugc_snapshots_review_audit RENAME TO _review_audit;
DROP INDEX idx_ugc_snapshots_review_audit_snapshot;
CREATE TABLE ugc_snapshots_review_audit (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  snapshot_id TEXT NOT NULL REFERENCES ugc_snapshots(id),
  from_status TEXT NOT NULL CHECK (from_status IN ('pending_openai','pending_audit','approved','rejected','unknown')),
  to_status TEXT NOT NULL CHECK (to_status IN ('pending_openai','pending_audit','approved','rejected','unknown')),
  source TEXT NOT NULL CHECK (source IN ('ai','admin')),
  admin_user_id TEXT REFERENCES users(uid),
  note TEXT,
  created_at TEXT NOT NULL,
  operation_kind TEXT NOT NULL DEFAULT 'review' CHECK (operation_kind IN ('review','correction','legacy')),
  first_publication INTEGER NOT NULL DEFAULT 0 CHECK (first_publication IN (0,1)),
  CHECK ((source='ai' AND admin_user_id IS NULL) OR (source='admin' AND admin_user_id IS NOT NULL))
);
-- Preserve identity and order without guessing which old admin actions were corrections.
INSERT INTO ugc_snapshots_review_audit
  (id,snapshot_id,from_status,to_status,source,admin_user_id,note,created_at,operation_kind)
SELECT id,snapshot_id,from_status,to_status,source,admin_user_id,note,created_at,'legacy'
FROM _review_audit ORDER BY rowid;
DROP TABLE _review_audit;
CREATE INDEX idx_ugc_snapshots_review_audit_snapshot ON ugc_snapshots_review_audit(snapshot_id);
CREATE INDEX idx_ugc_review_event_time ON ugc_snapshots_review_audit(created_at,event_sequence);
CREATE TRIGGER prevent_ugc_snapshots_review_audit_update BEFORE UPDATE ON ugc_snapshots_review_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_snapshots_review_audit_delete BEFORE DELETE ON ugc_snapshots_review_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;

ALTER TABLE ugc_submissions ADD COLUMN has_been_published INTEGER NOT NULL DEFAULT 0
  CHECK (has_been_published IN (0,1));
UPDATE ugc_submissions AS s SET has_been_published=1
WHERE EXISTS (SELECT 1 FROM ugc_snapshots f WHERE f.submission_id=s.id AND f.review_status='approved')
   OR EXISTS (SELECT 1 FROM ugc_snapshots_review_audit a JOIN ugc_snapshots f ON f.id=a.snapshot_id
     WHERE f.submission_id=s.id AND a.to_status='approved');

CREATE TABLE ugc_vote_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  submission_id TEXT NOT NULL REFERENCES ugc_submissions(id),
  actor_user_id TEXT NOT NULL REFERENCES users(uid),
  previous_value INTEGER NOT NULL CHECK (previous_value IN (-1,0,1)),
  next_value INTEGER NOT NULL CHECK (next_value IN (-1,0,1)),
  created_at TEXT NOT NULL,
  CHECK (previous_value<>next_value)
);
CREATE INDEX idx_ugc_vote_event_submission ON ugc_vote_events(submission_id,event_sequence);
CREATE INDEX idx_ugc_vote_event_time ON ugc_vote_events(created_at,event_sequence);
CREATE TRIGGER prevent_ugc_vote_event_update BEFORE UPDATE ON ugc_vote_events
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_vote_event_delete BEFORE DELETE ON ugc_vote_events
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
