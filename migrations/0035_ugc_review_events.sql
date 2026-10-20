CREATE TABLE IF NOT EXISTS ugc_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES ugc_submissions(id),
  snapshot_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  ai_reviewed INTEGER NOT NULL DEFAULT 1 CHECK (ai_reviewed IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('auto_moderation', 'manual_moderation', 'user_action')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ugc_review_events_snapshot
  ON ugc_review_events(submission_id, snapshot_id, id);
