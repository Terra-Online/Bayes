// Internal SQL projections keep the chosen body and snapshot identity together.
// Context traversal needs hidden structural rows too; only public_snapshot_id
// grants display access. Callers filter before mapping any row to a DTO.
export const publicCommentRows = `comment_rows AS NOT MATERIALIZED (
  SELECT s.*, r.id AS snapshot_id, r.content,
    r.review_status, r.created_at AS snapshot_created_at
  FROM ugc_submissions s
  LEFT JOIN ugc_snapshots r ON r.id = (
    SELECT public_snapshot_id FROM ugc_submission_visibility WHERE submission_id = s.id
  )
)`;

export const ownerCommentRows = `comment_rows AS NOT MATERIALIZED (
  SELECT s.*, r.id AS snapshot_id, r.content,
    r.review_status, r.created_at AS snapshot_created_at
  FROM ugc_submissions s
  JOIN ugc_submission_visibility v ON v.submission_id = s.id
  JOIN ugc_snapshots r ON r.id = v.frontier_snapshot_id
)`;

// Start with the pending-only index so a small owner overlay never walks the
// author's full approved history before applying its limit.
export const pendingCommentRows = `comment_rows AS NOT MATERIALIZED (
  SELECT s.*, r.id AS snapshot_id, r.content,
    r.review_status, r.created_at AS snapshot_created_at
  FROM ugc_snapshots r INDEXED BY idx_ugc_snapshots_one_pending
  JOIN ugc_submissions s ON s.id = r.submission_id AND s.revision = r.revision
  WHERE r.review_status IN ('pending_openai', 'pending_audit')
)`;
