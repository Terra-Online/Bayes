CREATE INDEX IF NOT EXISTS idx_progress_stats_outbox_active_health
  ON progress_stats_outbox(status, created_at)
  WHERE status IN ('pending', 'retry', 'blocked');

CREATE INDEX IF NOT EXISTS idx_progress_stats_outbox_unprocessed_user
  ON progress_stats_outbox(uid, id, status)
  WHERE status <> 'processed';

DROP INDEX IF EXISTS idx_progress_stats_outbox_user_order;

CREATE INDEX IF NOT EXISTS idx_progress_stats_outbox_processed_cleanup
  ON progress_stats_outbox(status, processed_at, id)
  WHERE status = 'processed';

CREATE INDEX IF NOT EXISTS idx_ugc_user_kind_poi_created
  ON ugc_submissions(user_id, kind, poi_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_users_karma_sweep
  ON users(uid)
  WHERE role <> 'r' AND karma < 5;
