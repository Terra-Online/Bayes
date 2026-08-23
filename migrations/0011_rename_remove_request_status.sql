PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS ugc_submissions_next (
  id TEXT PRIMARY KEY,
  poi_id TEXT NOT NULL,
  poi_hash TEXT NOT NULL,
  poi_type TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  content TEXT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_openai'
    CHECK (status IN ('pending_openai', 'pending_audit', 'active', 'flagged', 'remove_request', 'stale')),
  moderation_note TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT OR REPLACE INTO ugc_submissions_next (
  id,
  poi_id,
  poi_hash,
  poi_type,
  snapshot_id,
  user_id,
  content,
  file_path,
  status,
  moderation_note,
  mime_type,
  size_bytes,
  created_at,
  updated_at
)
SELECT
  id,
  poi_id,
  poi_hash,
  poi_type,
  snapshot_id,
  user_id,
  content,
  file_path,
  CASE status WHEN 'pending_removal' THEN 'remove_request' ELSE status END,
  moderation_note,
  mime_type,
  size_bytes,
  created_at,
  updated_at
FROM ugc_submissions;

DROP TABLE ugc_submissions;
ALTER TABLE ugc_submissions_next RENAME TO ugc_submissions;

CREATE INDEX IF NOT EXISTS idx_ugc_status_created ON ugc_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_poi_status_created ON ugc_submissions(poi_type, poi_hash, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_poi_id_status_created ON ugc_submissions(poi_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_user_created ON ugc_submissions(user_id, created_at);

PRAGMA foreign_keys = ON;
