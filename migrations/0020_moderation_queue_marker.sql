ALTER TABLE ugc_submissions ADD COLUMN moderation_queued_at TEXT;

CREATE INDEX IF NOT EXISTS idx_ugc_submissions_pending_openai_queue
  ON ugc_submissions(status, moderation_queued_at, created_at);
