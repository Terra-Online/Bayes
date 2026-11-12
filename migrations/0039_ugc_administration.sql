-- Unified deletion stores current state. Histories begin at this cutover;
-- existing review audits and immutable snapshots are retained without backfill.
DROP VIEW v_ugc_public_submissions;
DROP VIEW v_ugc_submission_visibility;
ALTER TABLE ugc_submissions ADD COLUMN deleted_at TEXT;
ALTER TABLE ugc_submissions ADD COLUMN deleted_by TEXT REFERENCES users(uid);
ALTER TABLE ugc_submissions ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0;
-- Scoring facts evolve only through normal reviews. Administrative corrections,
-- editorial revisions and deletion must not alter the periodic quality score.
ALTER TABLE ugc_submissions ADD COLUMN karma_review_status TEXT
  CHECK (karma_review_status IN ('approved','rejected'));
UPDATE ugc_submissions SET
  deleted_at=CASE WHEN author_deleted_at IS NOT NULL AND
    (admin_deleted_at IS NULL OR author_deleted_at<=admin_deleted_at)
    THEN author_deleted_at ELSE admin_deleted_at END,
  deleted_by=CASE WHEN author_deleted_at IS NOT NULL AND
    (admin_deleted_at IS NULL OR author_deleted_at<=admin_deleted_at)
    THEN user_id ELSE admin_deleted_by END;
ALTER TABLE ugc_submissions DROP COLUMN author_deleted_at;
ALTER TABLE ugc_submissions DROP COLUMN admin_deleted_at;
ALTER TABLE ugc_submissions DROP COLUMN admin_deleted_by;
ALTER TABLE ugc_snapshots ADD COLUMN baseline_snapshot_id TEXT REFERENCES ugc_snapshots(id);
ALTER TABLE ugc_snapshots ADD COLUMN source_snapshot_id TEXT REFERENCES ugc_snapshots(id);
ALTER TABLE ugc_snapshots ADD COLUMN edit_note TEXT;
ALTER TABLE ugc_snapshots ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'user'
  CHECK (creation_source IN ('user','admin'));
ALTER TABLE ugc_snapshots ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
UPDATE ugc_snapshots SET creation_source='admin' WHERE creator_user_id<>(
  SELECT user_id FROM ugc_submissions WHERE id=submission_id);

CREATE TABLE ugc_submission_audit (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES ugc_submissions(id),
  action TEXT NOT NULL CHECK (action IN ('deleted','restored')),
  actor_user_id TEXT NOT NULL REFERENCES users(uid),
  deleted_at TEXT NOT NULL,
  deleted_by TEXT REFERENCES users(uid),
  lifecycle_version INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (submission_id,lifecycle_version)
);
CREATE INDEX idx_ugc_submission_audit_history ON ugc_submission_audit(submission_id,created_at,id);
CREATE TABLE ugc_submission_flag_audit (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activated','withdrawn','cleared')),
  actor_user_id TEXT NOT NULL REFERENCES users(uid),
  operation_id TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id,reporter_user_id) REFERENCES ugc_submission_flags(submission_id,user_id),
  CHECK (action='cleared' OR actor_user_id=reporter_user_id)
);
CREATE INDEX idx_ugc_flag_audit_history ON ugc_submission_flag_audit(submission_id,created_at,id);
CREATE INDEX idx_ugc_flag_audit_operation ON ugc_submission_flag_audit(operation_id);

DROP TRIGGER prevent_ugc_snapshot_content_update;
CREATE TRIGGER prevent_ugc_snapshot_content_update
BEFORE UPDATE ON ugc_snapshots
WHEN NEW.id IS NOT OLD.id OR NEW.submission_id IS NOT OLD.submission_id
  OR NEW.kind IS NOT OLD.kind OR NEW.revision IS NOT OLD.revision
  OR NEW.content IS NOT OLD.content OR NEW.file_path IS NOT OLD.file_path
  OR NEW.mime_type IS NOT OLD.mime_type OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.creator_user_id IS NOT OLD.creator_user_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.baseline_snapshot_id IS NOT OLD.baseline_snapshot_id
  OR NEW.source_snapshot_id IS NOT OLD.source_snapshot_id
  OR NEW.edit_note IS NOT OLD.edit_note OR NEW.creation_source IS NOT OLD.creation_source
BEGIN SELECT RAISE(ABORT,'snapshot content and provenance are immutable'); END;
CREATE TRIGGER prevent_historical_pending_review
BEFORE UPDATE OF review_status ON ugc_snapshots
WHEN NEW.review_status IN ('pending_openai','pending_audit') AND NEW.revision<>(
  SELECT revision FROM ugc_submissions WHERE id=NEW.submission_id)
BEGIN SELECT RAISE(ABORT,'only the frontier may be pending'); END;
CREATE TRIGGER prevent_historical_pending_insert
BEFORE INSERT ON ugc_snapshots
WHEN NEW.review_status IN ('pending_openai','pending_audit') AND NEW.revision NOT IN (
  SELECT revision FROM ugc_submissions WHERE id=NEW.submission_id
  UNION ALL SELECT revision+1 FROM ugc_submissions WHERE id=NEW.submission_id)
BEGIN SELECT RAISE(ABORT,'only the frontier may be pending'); END;
CREATE TRIGGER prevent_ugc_submission_audit_update BEFORE UPDATE ON ugc_submission_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_submission_audit_delete BEFORE DELETE ON ugc_submission_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_submission_flag_audit_update BEFORE UPDATE ON ugc_submission_flag_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_submission_flag_audit_delete BEFORE DELETE ON ugc_submission_flag_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_snapshots_review_audit_update BEFORE UPDATE ON ugc_snapshots_review_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;
CREATE TRIGGER prevent_ugc_snapshots_review_audit_delete BEFORE DELETE ON ugc_snapshots_review_audit
BEGIN SELECT RAISE(ABORT,'audit records are immutable'); END;

CREATE VIEW v_ugc_submission_visibility AS
SELECT
  s.id AS submission_id,
  s.kind, s.poi_id, s.poi_hash, s.poi_type, s.user_id,
  s.parent_id, s.comment_depth, s.created_at,
  f.id AS frontier_snapshot_id,
  f.review_status AS frontier_review_status,
  CASE
    WHEN s.deleted_at IS NOT NULL THEN NULL
    WHEN f.review_status = 'approved' THEN f.id
    WHEN f.review_status IN ('pending_openai', 'pending_audit')
      AND p.review_status = 'approved' THEN p.id
    ELSE NULL
  END AS public_snapshot_id,
  (s.deleted_at IS NULL
    AND f.review_status = 'approved') AS lifecycle_allows_edit
FROM ugc_submissions s
JOIN ugc_snapshots f
  ON f.submission_id = s.id AND f.revision = s.revision
LEFT JOIN ugc_snapshots p
  ON p.submission_id = s.id AND p.revision = f.revision - 1;

CREATE VIEW v_ugc_public_submissions AS
SELECT
  v.submission_id AS id, v.kind, v.poi_id, v.poi_hash, v.poi_type, v.user_id,
  v.parent_id, v.comment_depth, v.created_at,
  r.id AS snapshot_id, r.content, r.file_path, r.mime_type, r.size_bytes
FROM v_ugc_submission_visibility v
JOIN ugc_snapshots r
  ON r.submission_id = v.submission_id AND r.id = v.public_snapshot_id;

-- Preserve the existing evaluator's current inputs, without inventing audit events.
UPDATE ugc_submissions AS s SET karma_review_status=CASE
  WHEN EXISTS (SELECT 1 FROM v_ugc_submission_visibility v WHERE v.submission_id=s.id
    AND v.public_snapshot_id IS NOT NULL) THEN 'approved'
  WHEN s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM ugc_snapshots f
    WHERE f.submission_id=s.id AND f.revision=s.revision AND f.review_status='rejected'
    AND NOT EXISTS (SELECT 1 FROM ugc_snapshots p WHERE p.submission_id=s.id
      AND p.revision<f.revision AND p.review_status='approved')) THEN 'rejected'
  ELSE NULL END WHERE s.kind='image';
