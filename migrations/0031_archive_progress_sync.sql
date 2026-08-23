PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_progress_manifests (
  archive_index_hash TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL DEFAULT 1,
  bits_per_archive INTEGER NOT NULL DEFAULT 1,
  archive_count INTEGER NOT NULL,
  archive_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_archive_progress (
  uid TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  marker TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  archive_index_hash TEXT NOT NULL DEFAULT '',
  format_version INTEGER NOT NULL DEFAULT 1,
  bits_per_archive INTEGER NOT NULL DEFAULT 1,
  archive_count INTEGER NOT NULL DEFAULT 0,
  retained_archive_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER,
  last_mutation_id TEXT,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_archive_progress_index_hash
  ON user_archive_progress(archive_index_hash);

CREATE TABLE IF NOT EXISTS archive_progress_sync_mutations (
  uid TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  result_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, mutation_id),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_archive_progress_sync_mutations_created_at
  ON archive_progress_sync_mutations(created_at);
