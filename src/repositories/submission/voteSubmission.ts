import { mapVoteValue, toCount } from "./mapper";
import type { SubmissionVoteValue, ViewerVoteValue } from "./types";

export async function createSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO ugc_submission_upvotes (submission_id, user_id, active)
       VALUES (?1, ?2, 1)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET active = 1
       WHERE ugc_submission_upvotes.active = 0`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function deleteSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ugc_submission_upvotes
       SET active = 0
       WHERE submission_id = ?1
         AND user_id = ?2
         AND active = 1`
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function setSubmissionVote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
    value: SubmissionVoteValue;
  }
): Promise<ViewerVoteValue> {
  const current = await db
    .prepare(
      `SELECT value, active
       FROM ugc_submission_votes
       WHERE submission_id = ?1
         AND user_id = ?2
       LIMIT 1`
    )
    .bind(payload.submissionId, payload.userId)
    .first<{ value: number | string; active: number | string }>();

  const currentValue = Number(current?.active ?? 0) === 1 ? mapVoteValue(current?.value) : 0;
  if (currentValue === payload.value) {
    await db
      .prepare(
        `UPDATE ugc_submission_votes
         SET active = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE submission_id = ?1
           AND user_id = ?2
           AND active = 1`
      )
      .bind(payload.submissionId, payload.userId)
      .run();
    return 0;
  }

  await db
    .prepare(
      `INSERT INTO ugc_submission_votes (submission_id, user_id, value, active)
       VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET value = excluded.value,
                     active = 1,
                     updated_at = CURRENT_TIMESTAMP`
    )
    .bind(payload.submissionId, payload.userId, payload.value)
    .run();
  return payload.value;
}

export async function countSubmissionUpvotes(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ugc_submission_upvotes
       WHERE submission_id = ?1
         AND active = 1`
    )
    .bind(submissionId)
    .first<{ count: number | string }>();

  return toCount(row?.count);
}

export async function getSubmissionScore(db: D1Database, submissionId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(value), 0) AS score
       FROM ugc_submission_votes
       WHERE submission_id = ?1
         AND active = 1`
    )
    .bind(submissionId)
    .first<{ score: number | string }>();

  const score = Number(row?.score ?? 0);
  return Number.isFinite(score) ? Math.trunc(score) : 0;
}
