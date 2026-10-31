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
  const result = await db
    .prepare(`UPDATE ugc_submissions AS s
    SET admin_deleted_at=?3,admin_deleted_by=?2,updated_at=?3
    WHERE s.kind='image' AND s.admin_deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE uid=?2 AND role IN ('a','r'))
      AND EXISTS (SELECT 1 FROM ugc_snapshots f WHERE f.submission_id=s.id
        AND f.revision=s.revision AND f.file_path LIKE ?1 ESCAPE '\\')
    RETURNING poi_id`)
    .bind(`${escapeLikePattern(input.prefix)}/%`, input.adminUserId, new Date().toISOString())
    .all<{ poi_id: string }>();
  return {
    changedRows: result.results.length,
    markerIds: [...new Set(result.results.map((row) => row.poi_id))],
  };
}
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
