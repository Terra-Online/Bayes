export type KarmaEvaluationRow = {
  uid: string;
  role: string;
  karma: number | string;
  points: number | string;
  created_at: string;
  last_active: string;
  approved_images: number | string | null;
  rejected_images: number | string | null;
};

/** User-scoped periodic scoring facts. A hidden edit with an earlier approval
 * keeps its existing exemption; deletion/disable and unknown imports are never
 * reinterpreted as a review rejection. No notes or audit reconstruction is used.
 */
export async function listKarmaEvaluationUsers(
  db: D1Database,
  userIds: readonly string[],
): Promise<KarmaEvaluationRow[]> {
  const selectedUserValues = userIds.map((_, index) => `(?${index + 1})`).join(", ");
  const rows = await db
    .prepare(`WITH selected_users(uid) AS (
    VALUES ${selectedUserValues}
  ), image_stats AS (
    SELECT s.user_id,
      SUM(CASE WHEN v.public_snapshot_id IS NOT NULL THEN 1 ELSE 0 END) AS approved_images,
      SUM(CASE WHEN r.review_status='rejected'
        AND s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ugc_snapshots earlier
          WHERE earlier.submission_id=s.id AND earlier.revision<r.revision
          AND earlier.review_status='approved') THEN 1 ELSE 0 END) AS rejected_images
    FROM selected_users selected
    CROSS JOIN ugc_submissions s INDEXED BY idx_ugc_user_kind_poi_created
      ON selected.uid=s.user_id
    JOIN ugc_snapshots r ON r.submission_id=s.id AND r.revision=s.revision
    JOIN ugc_submission_visibility v ON v.submission_id=s.id
    WHERE s.kind='image'
    GROUP BY s.user_id
  )
  SELECT u.uid, u.role, u.karma, u.points, u.created_at, u.last_active,
    COALESCE(s.approved_images,0) AS approved_images,
    COALESCE(s.rejected_images,0) AS rejected_images
  FROM users u
  INNER JOIN selected_users selected ON selected.uid=u.uid
  LEFT JOIN image_stats s ON s.user_id=u.uid
  WHERE u.role<>'r' AND u.karma<5`)
    .bind(...userIds)
    .all<KarmaEvaluationRow>();
  return rows.results ?? [];
}
