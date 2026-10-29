// Internal image read projections. Each row selects a version and its file together;
// compatibility status is derived here, never persisted on the identity.
export const publicImageSelection = `(SELECT p.*,
  CASE WHEN EXISTS (SELECT 1 FROM ugc_submission_flags f
    WHERE f.submission_id=p.id AND f.active=1) THEN 'flagged' ELSE 'active' END AS status
  FROM ugc_public_submissions p)`;

export const ownerImageSelection = `(SELECT s.*, r.id AS snapshot_id, r.content,
  r.file_path, r.mime_type, r.size_bytes, r.moderation_queued_at,
  v.public_snapshot_id,
  CASE WHEN s.author_deleted_at IS NOT NULL OR s.admin_deleted_at IS NOT NULL
    OR r.review_status IN ('rejected','unknown') THEN 'stale'
    WHEN r.review_status IN ('pending_openai','pending_audit') THEN r.review_status
    WHEN EXISTS (SELECT 1 FROM ugc_submission_flags f
      WHERE f.submission_id=s.id AND f.active=1) THEN 'flagged' ELSE 'active' END AS status
  FROM ugc_submissions s
  JOIN ugc_submission_visibility v ON v.submission_id=s.id
  JOIN ugc_snapshots r ON r.id=v.frontier_snapshot_id AND r.submission_id=s.id)`;
