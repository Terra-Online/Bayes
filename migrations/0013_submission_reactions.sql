CREATE TABLE IF NOT EXISTS ugc_submission_upvotes (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

CREATE INDEX IF NOT EXISTS idx_ugc_submission_upvotes_user_created
  ON ugc_submission_upvotes(user_id, created_at);

CREATE TABLE IF NOT EXISTS ugc_submission_flags (
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (submission_id, user_id),
  FOREIGN KEY (submission_id) REFERENCES ugc_submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(uid)
);

CREATE INDEX IF NOT EXISTS idx_ugc_submission_flags_user_created
  ON ugc_submission_flags(user_id, created_at);
