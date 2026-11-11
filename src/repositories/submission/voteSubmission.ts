import type { UgcEventReference } from "@/services/ugc/contract/events";
import type { AuthUser } from "@/types/app";

import { mapVoteValue, toCount } from "./mapper";
import type { SubmissionVoteValue } from "./types";

export type SetImageUpvoteResult =
  | { outcome: "missing" | "hidden" }
  | {
      outcome: "committed";
      changed: boolean;
      markerId: string;
      upvoteCount: number;
      event: UgcEventReference | null;
    };

/** The conditional audit is the receipt authorizing this operation's state write. */
export async function setImageUpvote(
  db: D1Database,
  payload: { submissionId: string; actor: AuthUser; active: boolean },
): Promise<SetImageUpvoteResult> {
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(`INSERT INTO ugc_vote_events
      (id,submission_id,actor_user_id,previous_value,next_value,created_at)
      SELECT ?1,s.id,?3,COALESCE(v.active,0),?4,?5
      FROM ugc_submissions s
      JOIN v_ugc_submission_visibility visibility ON visibility.submission_id=s.id
      LEFT JOIN ugc_submission_upvotes v ON v.submission_id=s.id AND v.user_id=?3
      WHERE s.id=?2 AND s.kind='image' AND visibility.public_snapshot_id IS NOT NULL
        AND COALESCE(v.active,0)<>?4 RETURNING id`)
      .bind(eventId, payload.submissionId, payload.actor.uid, payload.active ? 1 : 0, now),
    payload.active
      ? db
          .prepare(`INSERT INTO ugc_submission_upvotes (submission_id,user_id,active,created_at)
          SELECT submission_id,actor_user_id,1,created_at FROM ugc_vote_events WHERE id=?1
          ON CONFLICT(submission_id,user_id) DO UPDATE SET active=1,created_at=excluded.created_at`)
          .bind(eventId)
      : db
          .prepare(`UPDATE ugc_submission_upvotes SET active=0
          WHERE submission_id=?1 AND user_id=?2
            AND EXISTS (SELECT 1 FROM ugc_vote_events WHERE id=?3)`)
          .bind(payload.submissionId, payload.actor.uid, eventId),
    db
      .prepare(`SELECT s.poi_id,v.public_snapshot_id,
      (SELECT COUNT(*) FROM ugc_submission_upvotes WHERE submission_id=s.id AND active=1) AS count
      FROM ugc_submissions s JOIN v_ugc_submission_visibility v ON v.submission_id=s.id
      WHERE s.id=?1 AND s.kind='image'`)
      .bind(payload.submissionId),
  ]);
  const row = results[2].results[0];
  if (!row) {
    return { outcome: "missing" };
  }
  if (!row.public_snapshot_id) {
    return { outcome: "hidden" };
  }
  const changed = results[0].results.length > 0;
  return {
    outcome: "committed",
    changed,
    markerId: String(row.poi_id),
    upvoteCount: toCount(row.count),
    event: changed ? { source: "vote", eventId } : null,
  };
}

export type SetCommentVoteResult =
  | { outcome: "missing" | "hidden" }
  | {
      outcome: "voted";
      markerId: string;
      previousVote: SubmissionVoteValue | 0;
      currentVote: SubmissionVoteValue | 0;
      score: number;
      event: UgcEventReference;
    };

/** Each effective toggle or reversal is retained, including cancellations and self-votes. */
export async function setSubmissionVote(
  db: D1Database,
  payload: { submissionId: string; actor: AuthUser; value: SubmissionVoteValue },
): Promise<SetCommentVoteResult> {
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(`INSERT INTO ugc_vote_events
      (id,submission_id,actor_user_id,previous_value,next_value,created_at)
      SELECT ?1,s.id,?3,CASE WHEN v.active=1 THEN v.value ELSE 0 END,
        CASE WHEN v.active=1 AND v.value=?4 THEN 0 ELSE ?4 END,?5
      FROM ugc_submissions s
      JOIN v_ugc_submission_visibility visibility ON visibility.submission_id=s.id
      LEFT JOIN ugc_submission_votes v ON v.submission_id=s.id AND v.user_id=?3
      WHERE s.id=?2 AND s.kind='comment' AND visibility.public_snapshot_id IS NOT NULL
      RETURNING previous_value,next_value`)
      .bind(eventId, payload.submissionId, payload.actor.uid, payload.value, now),
    db
      .prepare(`INSERT INTO ugc_submission_votes
      (submission_id,user_id,value,active,created_at,updated_at)
      SELECT submission_id,actor_user_id,?2,CASE WHEN next_value=0 THEN 0 ELSE 1 END,created_at,created_at
      FROM ugc_vote_events WHERE id=?1
      ON CONFLICT(submission_id,user_id) DO UPDATE SET value=excluded.value,
        active=excluded.active,updated_at=excluded.updated_at`)
      .bind(eventId, payload.value),
    db
      .prepare(`SELECT s.poi_id,v.public_snapshot_id,
      (SELECT COALESCE(SUM(value),0) FROM ugc_submission_votes WHERE submission_id=s.id AND active=1) AS score
      FROM ugc_submissions s JOIN v_ugc_submission_visibility v ON v.submission_id=s.id
      WHERE s.id=?1 AND s.kind='comment'`)
      .bind(payload.submissionId),
  ]);
  const row = results[2].results[0];
  if (!row) {
    return { outcome: "missing" };
  }
  const event = results[0].results[0];
  if (!row.public_snapshot_id || !event) {
    return { outcome: "hidden" };
  }
  return {
    outcome: "voted",
    markerId: String(row.poi_id),
    previousVote: mapVoteValue(event.previous_value),
    currentVote: mapVoteValue(event.next_value),
    score: Number(row.score),
    event: { source: "vote", eventId },
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
