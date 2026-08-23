PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified TEXT NOT NULL DEFAULT 'false',
  role TEXT NOT NULL DEFAULT 'normal' CHECK (role IN ('normal', 'moderator', 'admin')),
  avt INTEGER NOT NULL DEFAULT 0,
  nickname TEXT NOT NULL UNIQUE,
  progress_version INTEGER NOT NULL DEFAULT 0,
  progress_marker TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ugc_submissions (
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

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);
CREATE INDEX IF NOT EXISTS idx_ugc_status_created ON ugc_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_poi_status_created ON ugc_submissions(poi_type, poi_hash, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_poi_id_status_created ON ugc_submissions(poi_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_user_created ON ugc_submissions(user_id, created_at);
