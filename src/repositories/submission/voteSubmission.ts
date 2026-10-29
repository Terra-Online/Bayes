import {
  notificationsFromResult,
  prepareCommentVoteNotificationWrite,
  prepareImageUpvoteNotificationWrite,
  type NotificationRecord,
} from "@/repositories/notifications";
import type { AuthUser } from "@/types/app";

import { mapVoteValue, toCount } from "./mapper";
import type { SubmissionVoteValue } from "./types";

export async function createSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    actor: AuthUser;
  },
): Promise<{ created: boolean; notifications: NotificationRecord[] }> {
  const changedAt = new Date().toISOString();
  const notificationStatements = prepareImageUpvoteNotificationWrite(db, {
    submissionId: payload.submissionId,
    actor: payload.actor,
    changedAt,
  });
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `INSERT INTO ugc_submission_upvotes (submission_id, user_id, active, created_at)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(submission_id, user_id)
       DO UPDATE SET active = 1,
                     created_at = excluded.created_at
       WHERE ugc_submission_upvotes.active = 0
       RETURNING submission_id`,
      )
      .bind(payload.submissionId, payload.actor.uid, changedAt),
    ...notificationStatements,
  ]);

  return {
    created: (results[0]?.results ?? []).length > 0,
    notifications:
      notificationStatements.length > 0
        ? notificationsFromResult(results[notificationStatements.length])
        : [],
  };
}

export async function deleteSubmissionUpvote(
  db: D1Database,
  payload: {
    submissionId: string;
    userId: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ugc_submission_upvotes
       SET active = 0
       WHERE submission_id = ?1
         AND user_id = ?2
         AND active = 1`,
    )
    .bind(payload.submissionId, payload.userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export type SetCommentVoteResult =
  | { outcome: "missing" | "hidden" }
  | {
      outcome: "voted";
      markerId: string;
      previousVote: SubmissionVoteValue | 0;
      currentVote: SubmissionVoteValue | 0;
      score: number;
      notifications: NotificationRecord[];
    };

/** Eligibility, toggle/reversal, notification writes and result share one transaction. */
export async function setSubmissionVote(
  db: D1Database,
  payload: { submissionId: string; actor: AuthUser; value: SubmissionVoteValue },
): Promise<SetCommentVoteResult> {
  const changedAt = new Date().toISOString();
  const notificationStatements = prepareCommentVoteNotificationWrite(db, {
    ...payload,
    changedAt,
  });
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT value,active FROM ugc_submission_votes
      WHERE submission_id=?1 AND user_id=?2`)
      .bind(payload.submissionId, payload.actor.uid),
    db
      .prepare(`INSERT INTO ugc_submission_votes
      (submission_id,user_id,value,active,created_at,updated_at)
      SELECT submission_id,?2,?3,1,?4,?4 FROM ugc_submission_visibility
      WHERE submission_id=?1 AND kind='comment' AND public_snapshot_id IS NOT NULL
      ON CONFLICT(submission_id,user_id) DO UPDATE SET
        value=excluded.value,
        active=CASE WHEN ugc_submission_votes.active=1 AND ugc_submission_votes.value=excluded.value THEN 0 ELSE 1 END,
        updated_at=excluded.updated_at
      RETURNING submission_id`)
      .bind(payload.submissionId, payload.actor.uid, payload.value, changedAt),
    ...notificationStatements,
    db
      .prepare(`SELECT s.poi_id,v.public_snapshot_id,
        COALESCE((SELECT value FROM ugc_submission_votes WHERE submission_id=s.id AND user_id=?2 AND active=1),0) AS vote,
        (SELECT COALESCE(SUM(value),0) FROM ugc_submission_votes WHERE submission_id=s.id AND active=1) AS score
      FROM ugc_submissions s JOIN ugc_submission_visibility v ON v.submission_id=s.id
      WHERE s.id=?1 AND s.kind='comment'`)
      .bind(payload.submissionId, payload.actor.uid),
  ]);
  const row = results.at(-1)?.results[0];
  if (!row) {
    return { outcome: "missing" };
  }
  if (!row.public_snapshot_id || results[1].results.length === 0) {
    return { outcome: "hidden" };
  }
  const previous = results[0].results[0];
  return {
    outcome: "voted",
    markerId: String(row.poi_id),
    previousVote: Number(previous?.active) === 1 ? mapVoteValue(previous?.value) : 0,
    currentVote: mapVoteValue(row.vote),
    score: Number(row.score),
    notifications: notificationStatements.length
      ? notificationsFromResult(results[1 + notificationStatements.length])
      : [],
  };
}

export async function countSubmissionUpvotes(
  db: D1Database,
  submissionId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ugc_submission_upvotes
       WHERE submission_id = ?1
         AND active = 1`,
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
         AND active = 1`,
    )
    .bind(submissionId)
    .first<{ score: number | string }>();

  const score = Number(row?.score ?? 0);
  return Number.isFinite(score) ? Math.trunc(score) : 0;
}
