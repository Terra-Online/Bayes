-- Pause/drain old UGC and notification workers; run the whole file transactionally.
DROP TRIGGER notification_counter_after_insert;
DROP TRIGGER notification_counter_after_mark_read;
DROP TRIGGER notification_counter_after_mark_unread;
DROP TRIGGER notification_counter_after_delete_unread;
ALTER TABLE notifications RENAME TO _legacy_notifications;
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(uid),
  category TEXT NOT NULL CHECK (category IN ('system','community')),
  type TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(uid),
  submission_id TEXT REFERENCES ugc_submissions(id),
  parent_submission_id TEXT REFERENCES ugc_submissions(id),
  marker_id TEXT, poi_hash TEXT, poi_type TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  projected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (source_kind IN ('legacy','review','vote')),
  source_event_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'legacy',
  UNIQUE(recipient_user_id,source_kind,source_event_id,purpose)
);
INSERT INTO notifications
 (id,recipient_user_id,category,type,actor_user_id,submission_id,parent_submission_id,
 marker_id,poi_hash,poi_type,payload_json,dedupe_key,read_at,created_at,source_event_id,purpose)
SELECT CASE WHEN position=1 THEN parent_id ELSE 'legacy-message:'||message_id END,
 recipient_user_id,category,type,actor_user_id,submission_id,parent_submission_id,
 marker_id,poi_hash,poi_type,payload_json,dedupe_key,read_at,
 strftime('%Y-%m-%dT%H:%M:%fZ',created_at),message_id,type
FROM (
 SELECT n.id AS parent_id,m.id AS message_id,n.recipient_user_id,n.category,n.type,
 m.actor_user_id,m.submission_id,m.parent_submission_id,m.marker_id,m.poi_hash,m.poi_type,
 m.payload_json,m.dedupe_key,n.read_at,m.created_at,
 ROW_NUMBER() OVER (PARTITION BY n.id ORDER BY m.created_at,m.id) AS position
 FROM _legacy_notifications n JOIN notification_messages m ON m.notification_id=n.id
);
INSERT INTO notifications
 (id,recipient_user_id,category,type,actor_user_id,submission_id,parent_submission_id,
 marker_id,poi_hash,poi_type,payload_json,dedupe_key,read_at,created_at,source_event_id,purpose)
SELECT n.id,n.recipient_user_id,n.category,n.type,n.actor_user_id,n.submission_id,n.parent_submission_id,
 n.marker_id,n.poi_hash,n.poi_type,n.payload_json,n.dedupe_key,n.read_at,
 strftime('%Y-%m-%dT%H:%M:%fZ',n.created_at),n.id,n.type
FROM _legacy_notifications n WHERE NOT EXISTS (
 SELECT 1 FROM notification_messages m WHERE m.notification_id=n.id);
-- A missing parent must abort, rather than silently discard an orphan message.
CREATE TABLE _notification_check (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO _notification_check SELECT NOT EXISTS (
 SELECT 1 FROM notification_messages m LEFT JOIN _legacy_notifications n ON n.id=m.notification_id
 WHERE n.id IS NULL);
INSERT INTO _notification_check SELECT
 (SELECT COUNT(*) FROM notifications)=(SELECT COUNT(*) FROM notification_messages)+
 (SELECT COUNT(*) FROM _legacy_notifications n WHERE NOT EXISTS (
 SELECT 1 FROM notification_messages m WHERE m.notification_id=n.id));
DROP TABLE _notification_check;
DROP TABLE notification_messages;
DROP TABLE _legacy_notifications;
CREATE INDEX idx_notifications_recipient_category_created
 ON notifications(recipient_user_id,category,created_at DESC,id DESC);
CREATE INDEX idx_notifications_recipient_category_unread_created
 ON notifications(recipient_user_id,category,read_at,created_at DESC,id DESC);
DELETE FROM notification_counters;
INSERT INTO notification_counters(user_id,system_unread,community_unread)
SELECT recipient_user_id,
 SUM(category='system' AND read_at IS NULL),SUM(category='community' AND read_at IS NULL)
FROM notifications GROUP BY recipient_user_id;
CREATE TRIGGER notification_counter_after_insert AFTER INSERT ON notifications
WHEN NEW.read_at IS NULL BEGIN
 INSERT INTO notification_counters(user_id,system_unread,community_unread)
 VALUES(NEW.recipient_user_id,NEW.category='system',NEW.category='community')
 ON CONFLICT(user_id) DO UPDATE SET
 system_unread=system_unread+(NEW.category='system'),
 community_unread=community_unread+(NEW.category='community'),updated_at=CURRENT_TIMESTAMP;
END;
CREATE TRIGGER notification_counter_after_mark_read AFTER UPDATE OF read_at ON notifications
WHEN OLD.read_at IS NULL AND NEW.read_at IS NOT NULL BEGIN
 UPDATE notification_counters SET system_unread=system_unread-(NEW.category='system'),
 community_unread=community_unread-(NEW.category='community'),updated_at=CURRENT_TIMESTAMP
 WHERE user_id=NEW.recipient_user_id;
END;
CREATE TRIGGER notification_counter_after_delete_unread AFTER DELETE ON notifications
WHEN OLD.read_at IS NULL BEGIN
 UPDATE notification_counters SET system_unread=system_unread-(OLD.category='system'),
 community_unread=community_unread-(OLD.category='community'),updated_at=CURRENT_TIMESTAMP
 WHERE user_id=OLD.recipient_user_id;
END;
CREATE TABLE notification_sources (
 source_kind TEXT PRIMARY KEY CHECK(source_kind IN ('review','vote')),
 cutover_sequence INTEGER NOT NULL,
 enabled_from TEXT NOT NULL
);
INSERT INTO notification_sources VALUES
 ('review',(SELECT COALESCE(MAX(event_sequence),0) FROM ugc_snapshots_review_audit),'1970-01-01T00:00:00.000Z'),
 ('vote',(SELECT COALESCE(MAX(event_sequence),0) FROM ugc_vote_events),'1970-01-01T00:00:00.000Z');
CREATE TABLE notification_collection_progress (
 user_id TEXT NOT NULL REFERENCES users(uid),
 source_kind TEXT NOT NULL REFERENCES notification_sources(source_kind),
 last_event_sequence INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,source_kind)
);
