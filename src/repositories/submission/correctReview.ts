import type { SnapshotReviewStatus, SubmissionKind } from "./types";

export interface ReviewCorrection {
  submissionId: string;
  snapshotId: string;
  actorId: string;
  expectedReviewStatus: SnapshotReviewStatus;
  expectedReviewVersion: number;
  decision: "approved" | "rejected";
  note?: string;
}

/** Corrections use the same audit receipt, without normal-review notifications or points. */
export async function correctSnapshotReview(db: D1Database, input: ReviewCorrection) {
  const auditId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.batch([
    db
      .prepare(`SELECT s.kind,s.poi_id AS markerId,f.review_status AS reviewStatus,
      f.review_version AS reviewVersion,
      EXISTS(SELECT 1 FROM users WHERE id=?3 AND role IN ('a','r')) AS authorized FROM ugc_submissions s
      JOIN ugc_snapshots f ON f.submission_id=s.id WHERE s.id=?1 AND f.id=?2`)
      .bind(input.submissionId, input.snapshotId, input.actorId),
    db
      .prepare(`INSERT INTO ugc_snapshots_review_audit
      (id,snapshot_id,from_status,to_status,source,admin_user_id,note,created_at)
      SELECT ?1,f.id,f.review_status,?5,'admin',?6,?7,?8 FROM ugc_snapshots f
      WHERE f.submission_id=?2 AND f.id=?3 AND f.review_status=?4 AND f.review_version=?9
        AND f.review_status<>?5 AND EXISTS (SELECT 1 FROM users WHERE id=?6 AND role IN ('a','r'))`)
      .bind(
        auditId,
        input.submissionId,
        input.snapshotId,
        input.expectedReviewStatus,
        input.decision,
        input.actorId,
        input.note ?? null,
        now,
        input.expectedReviewVersion,
      ),
    db
      .prepare(`UPDATE ugc_snapshots SET review_status=?2,review_version=review_version+1
      WHERE id=?3 AND EXISTS (SELECT 1 FROM ugc_snapshots_review_audit WHERE id=?1) RETURNING id`)
      .bind(auditId, input.decision, input.snapshotId),
  ]);
  const before = result[0].results[0] as
    | {
        kind: SubmissionKind;
        markerId: string;
        reviewStatus: SnapshotReviewStatus;
        reviewVersion: number;
        authorized: number;
      }
    | undefined;
  if (!before) {
    return { outcome: "missing" as const };
  }
  if (!before.authorized) {
    return { outcome: "forbidden" as const };
  }
  if (
    before.reviewStatus !== input.expectedReviewStatus ||
    before.reviewVersion !== input.expectedReviewVersion
  ) {
    return { outcome: "conflict" as const };
  }
  return {
    outcome: result[2].results.length ? ("committed" as const) : ("no_op" as const),
    target: before,
  };
}
