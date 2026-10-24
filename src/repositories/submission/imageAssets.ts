import { mapSubmission } from "./mapper";
import type { SubmissionRecord } from "./types";

export async function getPublicSubmissionByFilePath(
  db: D1Database,
  filePath: string,
): Promise<SubmissionRecord | null> {
  const row = await db
    .prepare(
      `SELECT *
       FROM ugc_submissions
       WHERE file_path = ?1
         AND kind = 'image'
         AND status IN ('active', 'flagged', 'remove_request')
       LIMIT 1`,
    )
    .bind(filePath)
    .first<Record<string, unknown>>();

  return row ? mapSubmission(row) : null;
}

export async function getImageSubmissionByFilePath(
  db: D1Database,
  filePath: string,
  viewer: { userId: string; includeAllOwners: boolean },
): Promise<SubmissionRecord | null> {
  // Multiple snapshots/owners can share a path. Filter access before LIMIT so
  // choosing a different index cannot turn an arbitrary owner's row into a 404.
  const row = await db
    .prepare(
      `SELECT *
       FROM ugc_submissions
       WHERE file_path = ?1
         AND kind = 'image'
         AND (?2 = 1 OR (user_id = ?3 AND status <> 'stale'))
       LIMIT 1`,
    )
    .bind(filePath, viewer.includeAllOwners ? 1 : 0, viewer.userId)
    .first<Record<string, unknown>>();

  return row ? mapSubmission(row) : null;
}
