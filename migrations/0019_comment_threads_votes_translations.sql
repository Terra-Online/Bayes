ALTER TABLE ugc_submissions
  ADD COLUMN parent_id TEXT;

ALTER TABLE ugc_submissions
  ADD COLUMN comment_depth INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ugc_comment_threads
  ON ugc_submissions(kind, poi_id, parent_id, status, created_at);

CREATE TABLE IF NOT EXISTS ugc_submission_votes (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (1, -1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

INSERT OR IGNORE INTO ugc_submission_votes (submission_id, user_id, value, created_at, updated_at)
SELECT submission_id, user_id, 1, created_at, created_at
FROM ugc_submission_upvotes;

CREATE INDEX IF NOT EXISTS idx_ugc_submission_votes_user_created
  ON ugc_submission_votes(user_id, created_at);
