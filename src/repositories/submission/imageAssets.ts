import { publicImageSelection, ownerImageSelection } from "./imageSelection";
import { mapSubmission } from "./mapper";
import type { SubmissionRecord } from "./types";

export async function getPublicSubmissionByFilePath(
  db: D1Database,
  filePath: string,
): Promise<SubmissionRecord | null> {
  // Narrow candidates with the snapshot file index, then verify the selected
  // public/frontier file. A retained historical reference alone grants no access.
  const row = await db
    .prepare(
      `SELECT *
       FROM ${publicImageSelection}
       WHERE file_path = ?1
         AND id IN (SELECT submission_id FROM ugc_snapshots WHERE file_path = ?1)
         AND kind = 'image'
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
       FROM ${ownerImageSelection}
       WHERE file_path = ?1
         AND id IN (SELECT submission_id FROM ugc_snapshots WHERE file_path = ?1)
         AND kind = 'image'
         AND (?2 = 1 OR user_id = ?3)
       LIMIT 1`,
    )
    .bind(filePath, viewer.includeAllOwners ? 1 : 0, viewer.userId)
    .first<Record<string, unknown>>();

  return row ? mapSubmission(row) : null;
}
