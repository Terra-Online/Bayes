CREATE INDEX IF NOT EXISTS idx_ugc_visible_comment_parent
  ON ugc_submissions(parent_id, created_at, id)
  WHERE kind = 'comment'
    AND status IN ('active', 'flagged', 'remove_request');
