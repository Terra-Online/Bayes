CREATE TABLE IF NOT EXISTS notifications (
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recipient_user_id) REFERENCES users(uid),
  FOREIGN KEY (actor_user_id) REFERENCES users(uid),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id),
  FOREIGN KEY (parent_submission_id) REFERENCES ugc_submissions(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_category_created
  ON notifications(recipient_user_id, category, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_category_unread_created
  ON notifications(recipient_user_id, category, read_at, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS notification_counters (
  user_id TEXT PRIMARY KEY,
  system_unread INTEGER NOT NULL DEFAULT 0 CHECK (system_unread >= 0),
  community_unread INTEGER NOT NULL DEFAULT 0 CHECK (community_unread >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

CREATE TRIGGER IF NOT EXISTS notification_counter_after_insert
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

CREATE TRIGGER IF NOT EXISTS notification_counter_after_mark_read
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

CREATE TRIGGER IF NOT EXISTS notification_counter_after_mark_unread
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

CREATE TRIGGER IF NOT EXISTS notification_counter_after_delete_unread
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
