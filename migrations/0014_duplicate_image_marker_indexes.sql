CREATE INDEX IF NOT EXISTS idx_ugc_kind_status_poi_created
  ON ugc_submissions(kind, status, poi_id, created_at);

