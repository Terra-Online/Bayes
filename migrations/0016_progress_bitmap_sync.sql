PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN progress_checksum TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN progress_marker_index_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN progress_format_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN progress_bits_per_point INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN progress_point_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN progress_updated_at INTEGER;
ALTER TABLE users ADD COLUMN progress_last_mutation_id TEXT;
ALTER TABLE users ADD COLUMN progress_cloud_synced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN progress_synced_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_progress_marker_index_hash
  ON users(progress_marker_index_hash);

CREATE INDEX IF NOT EXISTS idx_users_progress_updated_at
  ON users(progress_updated_at);

CREATE TABLE IF NOT EXISTS progress_marker_manifests (
  marker_index_hash TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL DEFAULT 1,
  bits_per_point INTEGER NOT NULL DEFAULT 1,
  point_count INTEGER NOT NULL,
  point_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS progress_stats_snapshots (
  marker_index_hash TEXT PRIMARY KEY,
  point_count INTEGER NOT NULL,
  total_synced_users INTEGER NOT NULL DEFAULT 0,
  counts TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
