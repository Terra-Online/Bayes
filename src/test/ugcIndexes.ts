export const UGC_COMPETING_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ugc_kind_status_created
    ON ugc_submissions(kind, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_ugc_kind_status_poi_created
    ON ugc_submissions(kind, status, poi_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ugc_comment_threads
    ON ugc_submissions(kind, poi_id, parent_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_ugc_poi_id_status_created
    ON ugc_submissions(poi_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_ugc_user_created
    ON ugc_submissions(user_id, created_at);
`;
