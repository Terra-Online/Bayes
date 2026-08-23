import { toCount } from "./mapper";

export async function createSubmissionFlag(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO ugc_submission_flags (submission_id, user_id, active)
       VALUES (?1, ?2, 1)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET active = 1
       WHERE ugc_submission_flags.active = 0`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function deleteSubmissionFlag(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ugc_submission_flags
       SET active = 0
       WHERE submission_id = ?1
         AND user_id = ?2
         AND active = 1`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function countSubmissionFlags(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ugc_submission_flags
       WHERE submission_id = ?1
         AND active = 1`
    )
    .bind(submissionId)
    .first<{ count: number | string }>();

  return toCount(row?.count);
}

export async function clearSubmissionFlags(db: D1Database, submissionId: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE ugc_submission_flags
       SET active = 0
       WHERE submission_id = ?1
         AND active = 1`
    )
    .bind(submissionId)
    .run();

  return result.meta.changes ?? 0;
}
