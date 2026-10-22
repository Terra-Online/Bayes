-- The HTTP contract allows 500 text units, with each nine-character emoji
-- token costing two units. Store up to 250 tokens (2250 source characters);
-- the application remains responsible for the rendered-unit limit.
-- D1 keeps foreign keys enabled. Detach cascading reaction tables before
-- rebuilding submissions so neither cascades nor append-only triggers lose data.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE ugc_submission_upvotes_backup AS SELECT * FROM ugc_submission_upvotes;

DROP TABLE ugc_submission_upvotes;

CREATE TABLE ugc_submission_flags_backup AS SELECT * FROM ugc_submission_flags;

DROP TABLE ugc_submission_flags;

CREATE TABLE ugc_submission_votes_backup AS SELECT * FROM ugc_submission_votes;

DROP TABLE ugc_submission_votes;

CREATE TABLE ugc_submissions_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'comment')),
  poi_id TEXT NOT NULL,
  poi_hash TEXT NOT NULL,
  poi_type TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending_openai'
    CHECK (status IN ('pending_openai', 'pending_audit', 'active', 'flagged', 'remove_request', 'stale')),
  moderation_note TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  parent_id TEXT,
  comment_depth INTEGER NOT NULL DEFAULT 0,
  moderation_queued_at TEXT,
  edit_original_content TEXT,
  edit_original_status TEXT,
  edit_original_snapshot_id TEXT,
  CHECK (kind = 'comment' OR file_path IS NOT NULL),
  CHECK (kind = 'image' OR (content IS NOT NULL AND LENGTH(TRIM(content)) > 0 AND LENGTH(content) <= 2250)),
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submissions_new (
  id, kind, poi_id, poi_hash,
  poi_type, snapshot_id, user_id, content,
  file_path, status, moderation_note, mime_type,
  size_bytes, created_at, updated_at, parent_id,
  comment_depth, moderation_queued_at, edit_original_content, edit_original_status,
  edit_original_snapshot_id
)
SELECT
  id, kind, poi_id, poi_hash,
  poi_type, snapshot_id, user_id, content,
  file_path, status, moderation_note, mime_type,
  size_bytes, created_at, updated_at, parent_id,
  comment_depth, moderation_queued_at, edit_original_content, edit_original_status,
  edit_original_snapshot_id
FROM ugc_submissions;

DROP TABLE ugc_submissions;

ALTER TABLE ugc_submissions_new RENAME TO ugc_submissions;

CREATE TABLE ugc_submission_upvotes (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submission_upvotes (submission_id, user_id, created_at, active)
SELECT submission_id, user_id, created_at, active FROM ugc_submission_upvotes_backup;

DROP TABLE ugc_submission_upvotes_backup;

CREATE TABLE ugc_submission_flags (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submission_flags (submission_id, user_id, created_at, active)
SELECT submission_id, user_id, created_at, active FROM ugc_submission_flags_backup;

DROP TABLE ugc_submission_flags_backup;

CREATE TABLE ugc_submission_votes (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (1, -1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submission_votes (submission_id, user_id, value, created_at, updated_at, active)
SELECT submission_id, user_id, value, created_at, updated_at, active FROM ugc_submission_votes_backup;

DROP TABLE ugc_submission_votes_backup;

CREATE INDEX idx_ugc_comment_threads
  ON ugc_submissions(kind, poi_id, parent_id, status, created_at);

CREATE INDEX idx_ugc_kind_status_created ON ugc_submissions(kind, status, created_at);

CREATE INDEX idx_ugc_kind_status_poi_created
  ON ugc_submissions(kind, status, poi_id, created_at);

CREATE INDEX idx_ugc_poi_id_status_created ON ugc_submissions(poi_id, status, created_at);

CREATE INDEX idx_ugc_poi_status_created ON ugc_submissions(poi_type, poi_hash, status, created_at);

CREATE INDEX idx_ugc_status_created ON ugc_submissions(status, created_at);

CREATE INDEX idx_ugc_submissions_file_path_kind
  ON ugc_submissions(file_path, kind);

CREATE INDEX idx_ugc_submissions_pending_openai_queue
  ON ugc_submissions(status, moderation_queued_at, created_at);

CREATE INDEX idx_ugc_user_created ON ugc_submissions(user_id, created_at);

CREATE INDEX idx_ugc_user_kind_poi_created
  ON ugc_submissions(user_id, kind, poi_id, created_at DESC, id DESC);

CREATE INDEX idx_ugc_user_pending_comment
  ON ugc_submissions(user_id, kind, poi_id, status, created_at DESC, id DESC)
  WHERE kind = 'comment' AND status IN ('pending_openai', 'pending_audit');

CREATE INDEX idx_ugc_visible_comment_parent
  ON ugc_submissions(parent_id, created_at, id)
  WHERE kind = 'comment'
    AND status IN ('active', 'flagged', 'remove_request');

CREATE TRIGGER prevent_ugc_submissions_delete
BEFORE DELETE ON ugc_submissions
BEGIN
  SELECT RAISE(ABORT, 'ugc_submissions is append-only; update status instead');
END;

CREATE INDEX idx_ugc_submission_upvotes_active_created
  ON ugc_submission_upvotes(active, created_at);

CREATE INDEX idx_ugc_submission_upvotes_active_submission
  ON ugc_submission_upvotes(active, submission_id);

CREATE INDEX idx_ugc_submission_upvotes_user_created
  ON ugc_submission_upvotes(user_id, created_at);

CREATE TRIGGER prevent_ugc_submission_upvotes_delete
BEFORE DELETE ON ugc_submission_upvotes
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_upvotes is append-only; set active = 0 instead');
END;

CREATE INDEX idx_ugc_submission_flags_user_created
  ON ugc_submission_flags(user_id, created_at);

CREATE TRIGGER prevent_ugc_submission_flags_delete
BEFORE DELETE ON ugc_submission_flags
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_flags is append-only; set active = 0 instead');
END;

CREATE INDEX idx_ugc_submission_votes_active_created
  ON ugc_submission_votes(active, created_at);

CREATE INDEX idx_ugc_submission_votes_user_created
  ON ugc_submission_votes(user_id, created_at);

CREATE TRIGGER prevent_ugc_submission_votes_delete
BEFORE DELETE ON ugc_submission_votes
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_votes is append-only; set active = 0 instead');
END;

PRAGMA defer_foreign_keys = OFF;
