-- Requires a paused, drained UGC write/review pipeline.

-- Execute the entire migration in one transaction; this file omits BEGIN/COMMIT.

PRAGMA defer_foreign_keys=ON;

CREATE TABLE _ugc_check (name TEXT, ok INTEGER NOT NULL CHECK (ok=1));

INSERT INTO _ugc_check SELECT 'no_pending_comments', NOT EXISTS (SELECT 1 FROM ugc_submissions WHERE kind='comment' AND status IN ('pending_openai','pending_audit'));

INSERT INTO _ugc_check SELECT 'non_null_ids', NOT EXISTS (SELECT 1 FROM ugc_submissions WHERE id IS NULL OR snapshot_id IS NULL);

INSERT INTO _ugc_check SELECT 'known_legacy_status', NOT EXISTS (SELECT 1 FROM ugc_submissions WHERE status NOT IN ('active','flagged','remove_request','stale','pending_openai','pending_audit'));

CREATE TABLE _ugc_source AS SELECT * FROM ugc_submissions;

-- Uses the current users(uid) internal key. No legacy payload or audit import.
-- Agreed import: one snapshot per submission, revision=1, creator=user_id,
-- created_at=old created_at. Discard edit backups, old events and old notes.
-- All old stale rows become unknown, with no inferred deletion facts.
-- Pause UGC writes/reviews and drain in-flight work; abort if pending comments exist.

CREATE TABLE ugc_submissions_next (
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
  FOREIGN KEY (submission_id, kind) REFERENCES ugc_submissions_next(id, kind),
  CHECK (kind <> 'image' OR file_path IS NOT NULL),
  CHECK (kind <> 'comment' OR (
    content IS NOT NULL
    AND LENGTH(TRIM(content)) > 0
    AND LENGTH(content) <= 2250
  ))
);

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

INSERT INTO ugc_submissions_next
  (id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,revision,
   created_at,updated_at)
SELECT id,kind,poi_id,poi_hash,poi_type,user_id,parent_id,comment_depth,1,
       created_at,updated_at FROM _ugc_source;

INSERT INTO ugc_snapshots
  (id,submission_id,kind,revision,content,file_path,mime_type,size_bytes,
   review_status,moderation_queued_at,creator_user_id,created_at)
SELECT snapshot_id,id,kind,1,content,file_path,mime_type,size_bytes,
       CASE
         WHEN status IN ('active','flagged','remove_request') THEN 'approved'
         WHEN status IN ('pending_openai','pending_audit') THEN status
         ELSE 'unknown'
       END,
       moderation_queued_at,user_id,created_at
FROM _ugc_source;

CREATE TABLE _ugc_submission_upvotes_backup AS SELECT * FROM ugc_submission_upvotes;

DROP TABLE ugc_submission_upvotes;

CREATE TABLE _ugc_submission_flags_backup AS SELECT * FROM ugc_submission_flags;

DROP TABLE ugc_submission_flags;

CREATE TABLE _ugc_submission_votes_backup AS SELECT * FROM ugc_submission_votes;

DROP TABLE ugc_submission_votes;

CREATE TABLE _notification_messages_backup AS SELECT * FROM notification_messages;

DROP TABLE notification_messages;

CREATE TABLE _notifications_backup AS SELECT * FROM notifications;

DROP TABLE notifications;

DROP TABLE ugc_review_events;

DROP TABLE ugc_submissions;

ALTER TABLE ugc_submissions_next RENAME TO ugc_submissions;

CREATE TABLE ugc_submission_upvotes (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submission_upvotes SELECT * FROM _ugc_submission_upvotes_backup;

INSERT INTO _ugc_check SELECT 'ugc_submission_upvotes_same', NOT EXISTS (SELECT * FROM ugc_submission_upvotes EXCEPT SELECT * FROM _ugc_submission_upvotes_backup) AND NOT EXISTS (SELECT * FROM _ugc_submission_upvotes_backup EXCEPT SELECT * FROM ugc_submission_upvotes);

DROP TABLE _ugc_submission_upvotes_backup;

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

CREATE TABLE ugc_submission_flags (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submission_flags SELECT * FROM _ugc_submission_flags_backup;

INSERT INTO _ugc_check SELECT 'ugc_submission_flags_same', NOT EXISTS (SELECT * FROM ugc_submission_flags EXCEPT SELECT * FROM _ugc_submission_flags_backup) AND NOT EXISTS (SELECT * FROM _ugc_submission_flags_backup EXCEPT SELECT * FROM ugc_submission_flags);

DROP TABLE _ugc_submission_flags_backup;

CREATE INDEX idx_ugc_submission_flags_user_created
  ON ugc_submission_flags(user_id, created_at);

CREATE TRIGGER prevent_ugc_submission_flags_delete
BEFORE DELETE ON ugc_submission_flags
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_flags is append-only; set active = 0 instead');
END;

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

INSERT INTO ugc_submission_votes SELECT * FROM _ugc_submission_votes_backup;

INSERT INTO _ugc_check SELECT 'ugc_submission_votes_same', NOT EXISTS (SELECT * FROM ugc_submission_votes EXCEPT SELECT * FROM _ugc_submission_votes_backup) AND NOT EXISTS (SELECT * FROM _ugc_submission_votes_backup EXCEPT SELECT * FROM ugc_submission_votes);

DROP TABLE _ugc_submission_votes_backup;

CREATE INDEX idx_ugc_submission_votes_active_created
  ON ugc_submission_votes(active, created_at);

CREATE INDEX idx_ugc_submission_votes_user_created
  ON ugc_submission_votes(user_id, created_at);

CREATE TRIGGER prevent_ugc_submission_votes_delete
BEFORE DELETE ON ugc_submission_votes
BEGIN
  SELECT RAISE(ABORT, 'ugc_submission_votes is append-only; set active = 0 instead');
END;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('system', 'community')),
  type TEXT NOT NULL,
  actor_user_id TEXT,
  submission_id TEXT,
  parent_submission_id TEXT,
  marker_id TEXT,
  poi_hash TEXT,
  poi_type TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, open_aggregation_key TEXT, window_started_at TEXT, window_expires_at TEXT, last_event_at TEXT, message_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (recipient_user_id) REFERENCES users(uid),
  FOREIGN KEY (actor_user_id) REFERENCES users(uid),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id),
  FOREIGN KEY (parent_submission_id) REFERENCES ugc_submissions(id)
);

INSERT INTO notifications SELECT * FROM _notifications_backup;

INSERT INTO _ugc_check SELECT 'notifications_same', NOT EXISTS (SELECT * FROM notifications EXCEPT SELECT * FROM _notifications_backup) AND NOT EXISTS (SELECT * FROM _notifications_backup EXCEPT SELECT * FROM notifications);

DROP TABLE _notifications_backup;

CREATE UNIQUE INDEX idx_notifications_open_aggregation_key
  ON notifications(open_aggregation_key);

CREATE INDEX idx_notifications_recipient_category_created
  ON notifications(recipient_user_id, category, created_at DESC, id DESC);

CREATE INDEX idx_notifications_recipient_category_last_event
  ON notifications(recipient_user_id, category, last_event_at DESC, id DESC);

CREATE INDEX idx_notifications_recipient_category_unread_created
  ON notifications(recipient_user_id, category, read_at, created_at DESC, id DESC);

CREATE TRIGGER notification_counter_after_delete_unread
AFTER DELETE ON notifications
WHEN OLD.read_at IS NULL
BEGIN
  UPDATE notification_counters
  SET
    system_unread = MAX(0, system_unread - CASE WHEN OLD.category = 'system' THEN 1 ELSE 0 END),
    community_unread = MAX(0, community_unread - CASE WHEN OLD.category = 'community' THEN 1 ELSE 0 END),
    updated_at = CURRENT_TIMESTAMP
  WHERE user_id = OLD.recipient_user_id;
END;

CREATE TRIGGER notification_counter_after_insert
AFTER INSERT ON notifications
WHEN NEW.read_at IS NULL
BEGIN
  INSERT INTO notification_counters (
    user_id,
    system_unread,
    community_unread,
    updated_at
  )
  VALUES (
    NEW.recipient_user_id,
    CASE WHEN NEW.category = 'system' THEN 1 ELSE 0 END,
    CASE WHEN NEW.category = 'community' THEN 1 ELSE 0 END,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(user_id) DO UPDATE SET
    system_unread = notification_counters.system_unread + CASE WHEN NEW.category = 'system' THEN 1 ELSE 0 END,
    community_unread = notification_counters.community_unread + CASE WHEN NEW.category = 'community' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER notification_counter_after_mark_read
AFTER UPDATE OF read_at ON notifications
WHEN OLD.read_at IS NULL AND NEW.read_at IS NOT NULL
BEGIN
  UPDATE notification_counters
  SET
    system_unread = MAX(0, system_unread - CASE WHEN NEW.category = 'system' THEN 1 ELSE 0 END),
    community_unread = MAX(0, community_unread - CASE WHEN NEW.category = 'community' THEN 1 ELSE 0 END),
    updated_at = CURRENT_TIMESTAMP
  WHERE user_id = NEW.recipient_user_id;
END;

CREATE TRIGGER notification_counter_after_mark_unread
AFTER UPDATE OF read_at ON notifications
WHEN OLD.read_at IS NOT NULL AND NEW.read_at IS NULL
BEGIN
  INSERT INTO notification_counters (
    user_id,
    system_unread,
    community_unread,
    updated_at
  )
  VALUES (
    NEW.recipient_user_id,
    CASE WHEN NEW.category = 'system' THEN 1 ELSE 0 END,
    CASE WHEN NEW.category = 'community' THEN 1 ELSE 0 END,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(user_id) DO UPDATE SET
    system_unread = notification_counters.system_unread + CASE WHEN NEW.category = 'system' THEN 1 ELSE 0 END,
    community_unread = notification_counters.community_unread + CASE WHEN NEW.category = 'community' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TABLE notification_messages (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  actor_user_id TEXT,
  submission_id TEXT,
  parent_submission_id TEXT,
  marker_id TEXT,
  poi_hash TEXT,
  poi_type TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(uid),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id),
  FOREIGN KEY (parent_submission_id) REFERENCES ugc_submissions(id)
);

INSERT INTO notification_messages SELECT * FROM _notification_messages_backup;

INSERT INTO _ugc_check SELECT 'notification_messages_same', NOT EXISTS (SELECT * FROM notification_messages EXCEPT SELECT * FROM _notification_messages_backup) AND NOT EXISTS (SELECT * FROM _notification_messages_backup EXCEPT SELECT * FROM notification_messages);

DROP TABLE _notification_messages_backup;

CREATE INDEX idx_notification_messages_parent_created
  ON notification_messages(notification_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX idx_ugc_snapshots_one_pending
  ON ugc_snapshots(submission_id)
  WHERE review_status IN ('pending_openai', 'pending_audit');

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
CREATE VIEW v_ugc_submission_visibility AS
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

CREATE VIEW v_ugc_public_submissions AS
SELECT
  v.submission_id AS id, v.kind, v.poi_id, v.poi_hash, v.poi_type, v.user_id,
  v.parent_id, v.comment_depth, v.created_at,
  r.id AS snapshot_id, r.content, r.file_path, r.mime_type, r.size_bytes
FROM v_ugc_submission_visibility v
JOIN ugc_snapshots r
  ON r.submission_id = v.submission_id AND r.id = v.public_snapshot_id;

INSERT INTO _ugc_check SELECT 'one_snapshot_per_submission', (SELECT COUNT(*) FROM ugc_submissions)=(SELECT COUNT(*) FROM _ugc_source) AND (SELECT COUNT(*) FROM ugc_snapshots)=(SELECT COUNT(*) FROM _ugc_source);

INSERT INTO _ugc_check SELECT 'content_and_identity_preserved', NOT EXISTS (
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
);

INSERT INTO _ugc_check SELECT 'empty_new_audit', NOT EXISTS (SELECT 1 FROM ugc_snapshots_review_audit);

DROP TABLE _ugc_source;

DROP TABLE _ugc_check;

-- Keep deferral enabled until commit; foreign keys must then be valid.
