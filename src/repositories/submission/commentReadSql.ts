// Internal SQL projections keep the chosen body and snapshot identity together.
// Context traversal needs hidden structural rows too; only public_snapshot_id
// grants display access. Mapping a hidden structural row produces a content-free placeholder.
export const publicCommentRows = `comment_rows AS NOT MATERIALIZED (
  SELECT s.*, r.id AS snapshot_id, r.content,
    r.review_status, r.created_at AS snapshot_created_at
  FROM ugc_submissions s
  LEFT JOIN ugc_snapshots r ON r.id = (
    SELECT public_snapshot_id FROM v_ugc_submission_visibility WHERE submission_id = s.id
  )
)`;

export const ownerCommentRows = `comment_rows AS NOT MATERIALIZED (
  SELECT s.*, r.id AS snapshot_id, r.content,
    r.review_status, r.created_at AS snapshot_created_at
  FROM ugc_submissions s
  JOIN v_ugc_submission_visibility v ON v.submission_id = s.id
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

/** Public nodes and all same-point ancestors form the pruned discussion tree.
 * UNION deduplicates shared ancestors and terminates corrupt parent cycles.
 * markerIdsSql is an internal SQL expression, never request text.
 */
export function retainedCommentRows(markerIdsSql: string): string {
  return `retained_comments(id, poi_id, parent_id) AS (
    SELECT id, poi_id, parent_id FROM comment_rows
    WHERE kind='comment' AND snapshot_id IS NOT NULL AND poi_id IN (${markerIdsSql})
    UNION
    SELECT parent.id, parent.poi_id, parent.parent_id
    FROM retained_comments child JOIN comment_rows parent ON parent.id=child.parent_id
    WHERE parent.kind='comment' AND parent.poi_id=child.poi_id
  )`;
}
