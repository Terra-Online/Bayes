-- A file path can occur in multiple snapshots/owners. Keep the index non-unique.
CREATE INDEX IF NOT EXISTS idx_ugc_submissions_file_path_kind
  ON ugc_submissions(file_path, kind);

-- Repair installations where 0027 was recorded without this index being present.
-- Do not edit/replay historical migrations or change existing vote semantics.
CREATE INDEX IF NOT EXISTS idx_ugc_submission_upvotes_active_submission
  ON ugc_submission_upvotes(active, submission_id);
