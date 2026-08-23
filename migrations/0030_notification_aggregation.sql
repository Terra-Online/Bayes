ALTER TABLE notifications ADD COLUMN open_aggregation_key TEXT;
ALTER TABLE notifications ADD COLUMN window_started_at TEXT;
ALTER TABLE notifications ADD COLUMN window_expires_at TEXT;
ALTER TABLE notifications ADD COLUMN last_event_at TEXT;
ALTER TABLE notifications ADD COLUMN message_count INTEGER NOT NULL DEFAULT 1;

UPDATE notifications
SET last_event_at = created_at
WHERE last_event_at IS NULL;

DELETE FROM notifications
WHERE type = 'system.submission.rejected';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_open_aggregation_key
  ON notifications(open_aggregation_key);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_category_last_event
  ON notifications(recipient_user_id, category, last_event_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS notification_messages (
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

CREATE INDEX IF NOT EXISTS idx_notification_messages_parent_created
  ON notification_messages(notification_id, created_at ASC, id ASC);
