CREATE INDEX IF NOT EXISTS idx_ugc_user_pending_comment
  ON ugc_submissions(user_id, kind, poi_id, status, created_at DESC, id DESC)
  WHERE kind = 'comment' AND status IN ('pending_openai', 'pending_audit');
