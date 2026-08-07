import { mapVoteValue, toCount } from "./mapper";
import type { SubmissionVoteValue, ViewerVoteValue } from "./types";
import type { AuthUser } from "../../types/app";
import {
  notificationsFromResult,
  prepareCommentVoteNotificationWrite,
  prepareImageUpvoteNotificationWrite,
  type CommentVoteResult,
  type NotificationRecord
} from "../notifications";

export async function createSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    actor: AuthUser;
  }
): Promise<{ created: boolean; notifications: NotificationRecord[] }> {
  const changedAt = new Date().toISOString();
  const notificationStatements = prepareImageUpvoteNotificationWrite(db, {
    submissionId: payload.submissionId,
    actor: payload.actor,
    changedAt
  });
  const results = await db.batch<Record<string, unknown>>([
    db.prepare(
      `INSERT INTO ugc_submission_upvotes (submission_id, user_id, active, created_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET active = 1,
                     created_at = excluded.created_at
       WHERE ugc_submission_upvotes.active = 0
       RETURNING submission_id`
    ).bind(payload.submissionId, payload.actor.uid, changedAt),
    ...notificationStatements
  ]);

  return {
    created: (results[0]?.results ?? []).length > 0,
    notifications: notificationStatements.length > 0
      ? notificationsFromResult(results[notificationStatements.length])
      : []
  };
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
    actor: AuthUser;
    value: SubmissionVoteValue;
  }
): Promise<CommentVoteResult> {
  const current = await db
    .prepare(
      `SELECT value, active
       FROM ugc_submission_votes
       WHERE submission_id = ?1
         AND user_id = ?2
       LIMIT 1`
    )
    .bind(payload.submissionId, payload.actor.uid)
    .first<{ value: number | string; active: number | string }>();

  const previousVote = Number(current?.active ?? 0) === 1 ? mapVoteValue(current?.value) : 0;
  const changedAt = new Date().toISOString();
  if (previousVote === payload.value) {
    const result = await db
      .prepare(
        `UPDATE ugc_submission_votes
         SET active = 0,
             updated_at = ?3
         WHERE submission_id = ?1
           AND user_id = ?2
           AND active = 1`
      )
      .bind(payload.submissionId, payload.actor.uid, changedAt)
      .run();
    return {
      previousVote,
      currentVote: (result.meta.changes ?? 0) > 0 ? 0 : previousVote,
      notifications: []
    };
  }

  const notificationStatements = prepareCommentVoteNotificationWrite(db, {
    submissionId: payload.submissionId,
    actor: payload.actor,
    value: payload.value,
    changedAt
  });
  const results = await db.batch<Record<string, unknown>>([
    db.prepare(
      `INSERT INTO ugc_submission_votes (submission_id, user_id, value, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET value = excluded.value,
                     active = 1,
                     updated_at = excluded.updated_at
       RETURNING submission_id`
    )
      .bind(payload.submissionId, payload.actor.uid, payload.value, changedAt),
    ...notificationStatements
  ]);
  const voteResult = results[0];
  const notificationResult = notificationStatements.length > 0
    ? results[notificationStatements.length]
    : undefined;

  return {
    previousVote,
    currentVote: (voteResult.results ?? []).length > 0 ? payload.value : previousVote,
    notifications: notificationsFromResult(notificationResult)
  };
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
