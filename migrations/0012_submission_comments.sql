PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS ugc_submissions_v2 (
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
  CHECK (kind = 'comment' OR file_path IS NOT NULL),
  CHECK (kind = 'image' OR (content IS NOT NULL AND LENGTH(TRIM(content)) > 0 AND LENGTH(content) < 200)),
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT INTO ugc_submissions_v2 (
  id,
  kind,
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
  'image',
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
FROM ugc_submissions;

DROP TABLE ugc_submissions;
ALTER TABLE ugc_submissions_v2 RENAME TO ugc_submissions;

CREATE INDEX IF NOT EXISTS idx_ugc_status_created ON ugc_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_kind_status_created ON ugc_submissions(kind, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_poi_status_created ON ugc_submissions(poi_type, poi_hash, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_poi_id_status_created ON ugc_submissions(poi_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_user_created ON ugc_submissions(user_id, created_at);

PRAGMA foreign_keys = ON;
