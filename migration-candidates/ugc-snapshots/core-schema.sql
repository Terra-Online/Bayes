-- Design draft only. Not a repository migration or an execution script.
-- Uses the current users(uid) internal key. No legacy payload or audit import.
-- Local SQLite and Miniflare D1 prototype. Deployed D1 remains unverified.
-- Agreed import: one snapshot per submission, revision=1, creator=user_id,
-- created_at=old created_at. Discard edit backups, old events and old notes.
-- All old stale rows become unknown, with no inferred deletion facts.
-- Pause UGC writes/reviews and drain in-flight work; abort if pending comments exist.

CREATE TABLE ugc_submissions (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'comment')),
  poi_id TEXT NOT NULL,
  poi_hash TEXT NOT NULL,
  poi_type TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(uid),
  parent_id TEXT,
  comment_depth INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  author_deleted_at TEXT,
  admin_deleted_at TEXT,
  admin_deleted_by TEXT REFERENCES users(uid),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, kind)
);

CREATE TABLE ugc_snapshots (
  id TEXT NOT NULL PRIMARY KEY,
  submission_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'comment')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content TEXT,
  file_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  review_status TEXT NOT NULL CHECK (review_status IN (
    'pending_openai', 'pending_audit', 'approved', 'rejected', 'unknown'
  )),
  moderation_queued_at TEXT,
  creator_user_id TEXT NOT NULL REFERENCES users(uid),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (submission_id, revision),
  FOREIGN KEY (submission_id, kind) REFERENCES ugc_submissions(id, kind),
  CHECK (kind <> 'image' OR file_path IS NOT NULL),
  CHECK (kind <> 'comment' OR (
    content IS NOT NULL
    AND LENGTH(TRIM(content)) > 0
    AND LENGTH(content) <= 2250
  ))
);

CREATE UNIQUE INDEX idx_ugc_snapshots_one_pending
  ON ugc_snapshots(submission_id)
  WHERE review_status IN ('pending_openai', 'pending_audit');

CREATE TABLE ugc_snapshots_review_audit (
  id TEXT NOT NULL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES ugc_snapshots(id),
  from_status TEXT NOT NULL CHECK (from_status IN (
    'pending_openai', 'pending_audit', 'approved', 'rejected', 'unknown'
  )),
  to_status TEXT NOT NULL CHECK (to_status IN (
    'pending_openai', 'pending_audit', 'approved', 'rejected', 'unknown'
  )),
  source TEXT NOT NULL CHECK (source IN ('ai', 'admin')),
  admin_user_id TEXT REFERENCES users(uid),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (source = 'ai' AND admin_user_id IS NULL)
    OR (source = 'admin' AND admin_user_id IS NOT NULL)
  )
);

CREATE INDEX idx_ugc_snapshots_review_audit_snapshot
  ON ugc_snapshots_review_audit(snapshot_id);

CREATE INDEX idx_ugc_user_kind_poi_created
  ON ugc_submissions(user_id, kind, poi_id, created_at DESC, id DESC);
CREATE INDEX idx_ugc_user_created
  ON ugc_submissions(user_id, created_at DESC, id DESC);
CREATE INDEX idx_ugc_comment_parent
  ON ugc_submissions(parent_id, created_at, id) WHERE kind='comment';
CREATE INDEX idx_ugc_kind_poi_parent_created
  ON ugc_submissions(kind, poi_id, parent_id, created_at, id);
CREATE INDEX idx_ugc_kind_poi_created
  ON ugc_submissions(kind, poi_id, created_at, id);
CREATE INDEX idx_ugc_snapshots_queue
  ON ugc_snapshots(review_status, moderation_queued_at, submission_id);
CREATE INDEX idx_ugc_snapshots_file
  ON ugc_snapshots(file_path) WHERE file_path IS NOT NULL;

CREATE TRIGGER prevent_ugc_submissions_delete
BEFORE DELETE ON ugc_submissions
BEGIN SELECT RAISE(ABORT, 'ugc submissions are retained'); END;

CREATE TRIGGER prevent_ugc_snapshots_delete
BEFORE DELETE ON ugc_snapshots
BEGIN SELECT RAISE(ABORT, 'ugc snapshots are retained'); END;

CREATE TRIGGER prevent_ugc_snapshot_content_update
BEFORE UPDATE ON ugc_snapshots
WHEN NEW.id IS NOT OLD.id
  OR NEW.submission_id IS NOT OLD.submission_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.revision IS NOT OLD.revision
  OR NEW.content IS NOT OLD.content
  OR NEW.file_path IS NOT OLD.file_path
  OR NEW.mime_type IS NOT OLD.mime_type
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.creator_user_id IS NOT OLD.creator_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'snapshot content is immutable; append a new version'); END;

-- One row per valid submission; this view does not grant actor permissions.
CREATE VIEW ugc_submission_visibility AS
SELECT
  s.id AS submission_id,
  s.kind, s.poi_id, s.poi_hash, s.poi_type, s.user_id,
  s.parent_id, s.comment_depth, s.created_at,
  f.id AS frontier_snapshot_id,
  f.review_status AS frontier_review_status,
  CASE
    WHEN s.author_deleted_at IS NOT NULL OR s.admin_deleted_at IS NOT NULL THEN NULL
    WHEN f.review_status = 'approved' THEN f.id
    WHEN f.review_status IN ('pending_openai', 'pending_audit')
      AND p.review_status = 'approved' THEN p.id
    ELSE NULL
  END AS public_snapshot_id,
  (s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL
    AND f.review_status = 'approved') AS lifecycle_allows_edit
FROM ugc_submissions s
JOIN ugc_snapshots f
  ON f.submission_id = s.id AND f.revision = s.revision
LEFT JOIN ugc_snapshots p
  ON p.submission_id = s.id AND p.revision = f.revision - 1;

CREATE VIEW ugc_public_submissions AS
SELECT
  v.submission_id AS id, v.kind, v.poi_id, v.poi_hash, v.poi_type, v.user_id,
  v.parent_id, v.comment_depth, v.created_at,
  r.id AS snapshot_id, r.content, r.file_path, r.mime_type, r.size_bytes
FROM ugc_submission_visibility v
JOIN ugc_snapshots r
  ON r.submission_id = v.submission_id AND r.id = v.public_snapshot_id;
