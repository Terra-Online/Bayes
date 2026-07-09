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
      `INSERT OR IGNORE INTO ugc_submission_upvotes (submission_id, user_id)
       VALUES (?1, ?2)`
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
      `DELETE FROM ugc_submission_upvotes
       WHERE submission_id = ?1
         AND user_id = ?2`
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
      `SELECT value
       FROM ugc_submission_votes
       WHERE submission_id = ?1
         AND user_id = ?2
       LIMIT 1`
    )
    .bind(payload.submissionId, payload.userId)
    .first<{ value: number | string }>();

  const currentValue = mapVoteValue(current?.value);
  if (currentValue === payload.value) {
    await db
      .prepare(
        `DELETE FROM ugc_submission_votes
         WHERE submission_id = ?1
           AND user_id = ?2`
      )
      .bind(payload.submissionId, payload.userId)
      .run();
    return 0;
  }

  await db
    .prepare(
      `INSERT INTO ugc_submission_votes (submission_id, user_id, value)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET value = excluded.value,
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
       WHERE submission_id = ?1`
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
       WHERE submission_id = ?1`
    )
    .bind(submissionId)
    .first<{ score: number | string }>();

  const score = Number(row?.score ?? 0);
  return Number.isFinite(score) ? Math.trunc(score) : 0;
}
