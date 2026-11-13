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

/** Quality scoring uses preserved normal-review facts, independently of current
 * publication and administrative corrections. No audit replay is required.
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
      SUM(CASE WHEN s.karma_review_status='approved' THEN 1 ELSE 0 END) AS approved_images,
      SUM(CASE WHEN s.karma_review_status='rejected' THEN 1 ELSE 0 END) AS rejected_images
    FROM selected_users selected
    CROSS JOIN ugc_submissions s INDEXED BY idx_ugc_user_kind_poi_created
      ON selected.uid=s.user_id
    WHERE s.kind='image'
    GROUP BY s.user_id
  )
  SELECT u.id AS uid, u.role, u.karma, u.points, u.created_at, u.last_active,
    COALESCE(s.approved_images,0) AS approved_images,
    COALESCE(s.rejected_images,0) AS rejected_images
  FROM users u
  INNER JOIN selected_users selected ON selected.uid=u.id
  LEFT JOIN image_stats s ON s.user_id=u.id
  WHERE u.role<>'r' AND u.karma<5`)
    .bind(...userIds)
    .all<KarmaEvaluationRow>();
  return rows.results ?? [];
}
