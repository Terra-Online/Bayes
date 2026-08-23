PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS progress_sync_mutations (
  uid TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  result_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, mutation_id),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_sync_mutations_created_at
  ON progress_sync_mutations(created_at);

CREATE TABLE IF NOT EXISTS progress_stats_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  marker_index_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'processed', 'blocked')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_stats_outbox_dispatch
  ON progress_stats_outbox(status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_progress_stats_outbox_user_order
  ON progress_stats_outbox(uid, id, status);

ALTER TABLE progress_stats_snapshots
  ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 1;
