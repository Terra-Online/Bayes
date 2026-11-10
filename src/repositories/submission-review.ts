export async function listAllImageFilePaths(db: D1Database): Promise<string[]> {
  const filePaths: string[] = [];
  let cursor = "";

  for (;;) {
    const result = await db
      .prepare(
        `SELECT DISTINCT file_path
         FROM ugc_snapshots
         WHERE kind = 'image'
           AND file_path IS NOT NULL
           AND file_path > ?1
         ORDER BY file_path ASC
         LIMIT 1000`,
      )
      .bind(cursor)
      .all<{ file_path: string }>();
    const batch = (result.results ?? []).map((row) => row.file_path).filter(Boolean);
    filePaths.push(...batch);
    if (batch.length < 1000) {
      break;
    }
    cursor = batch[batch.length - 1];
  }

  return filePaths;
}

/** Explicit administrative archive: keep every row/object and review fact; record
 * the first disable fact. This bulk test tool does not issue review penalties.
 */
export async function archiveTestImageSubmissions(
  db: D1Database,
  input: { prefix: string; adminUserId: string },
): Promise<{ changedRows: number; markerIds: string[] }> {
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.batch([
    db
      .prepare(`INSERT INTO ugc_submission_audit
      (id,submission_id,action,actor_user_id,deleted_at,deleted_by,lifecycle_version,created_at)
      SELECT ?4||':'||s.id,s.id,'deleted',?2,?3,?2,s.lifecycle_version+1,?3
      FROM ugc_submissions s WHERE s.kind='image' AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM users WHERE uid=?2 AND role IN ('a','r'))
        AND EXISTS (SELECT 1 FROM ugc_snapshots f WHERE f.submission_id=s.id
          AND f.revision=s.revision AND f.file_path LIKE ?1 ESCAPE '\\')`)
      .bind(`${escapeLikePattern(input.prefix)}/%`, input.adminUserId, now, operationId),
    db
      .prepare(`UPDATE ugc_submissions AS s SET deleted_at=?3,deleted_by=?2,
      lifecycle_version=lifecycle_version+1,updated_at=?3
      WHERE EXISTS (SELECT 1 FROM ugc_submission_audit a WHERE a.id=?1||':'||s.id)
      RETURNING poi_id`)
      .bind(operationId, input.adminUserId, now),
  ]);
  const rows = result[1].results as { poi_id: string }[];
  return { changedRows: rows.length, markerIds: [...new Set(rows.map((row) => row.poi_id))] };
}
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
