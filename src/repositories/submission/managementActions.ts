import { changeSubmissionDeletion } from "./lifecycle";
import type { SubmissionKind } from "./types";

interface ManagementCommand {
  submissionId: string;
  adminUserId: string;
  note?: string;
}
export type ManagementResult =
  | { outcome: "conflict" }
  | { outcome: "committed" | "no_op"; target: { kind: SubmissionKind; markerId: string } };

/** Compatibility command; deletion now shares owner lifecycle semantics. */
export async function disableSubmission(
  db: D1Database,
  input: ManagementCommand & { snapshotId: string; expectedLifecycleVersion?: number },
): Promise<ManagementResult> {
  const result = await changeSubmissionDeletion(db, {
    submissionId: input.submissionId,
    actorId: input.adminUserId,
    snapshotId: input.snapshotId,
    note: input.note,
    permission: "reviewer",
    action: "deleted",
    expectedLifecycleVersion: input.expectedLifecycleVersion,
    initialDeletionOnly: input.expectedLifecycleVersion === undefined,
  });
  if (result.outcome !== "committed" && result.outcome !== "no_op") {
    return { outcome: "conflict" };
  }
  return { outcome: result.outcome, target: result.target };
}

/** Each changed report gets a receipt, grouped under one moderator operation. */
export async function clearSubmissionFlags(
  db: D1Database,
  input: ManagementCommand,
): Promise<ManagementResult> {
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const authorized = "EXISTS (SELECT 1 FROM users WHERE id=?2 AND role IN ('p','a','r'))";
  const result = await db.batch([
    db
      .prepare(`INSERT INTO ugc_submission_flag_audit
      (id,submission_id,reporter_user_id,action,actor_user_id,operation_id,note,created_at)
      SELECT lower(hex(randomblob(16))),g.submission_id,g.user_id,'cleared',?2,?3,?4,?5
      FROM ugc_submission_flags g WHERE submission_id=?1 AND active=1 AND ${authorized}
      RETURNING id`)
      .bind(input.submissionId, input.adminUserId, operationId, input.note ?? null, now),
    db
      .prepare(`UPDATE ugc_submission_flags AS g SET active=0
      WHERE submission_id=?1 AND active=1 AND EXISTS (
        SELECT 1 FROM ugc_submission_flag_audit a WHERE a.operation_id=?2
        AND a.submission_id=g.submission_id AND a.reporter_user_id=g.user_id)`)
      .bind(input.submissionId, operationId),
    db
      .prepare(`SELECT kind,poi_id AS markerId FROM ugc_submissions WHERE id=?1 AND ${authorized}`)
      .bind(input.submissionId, input.adminUserId),
  ]);
  const target = result[2].results[0] as { kind: SubmissionKind; markerId: string } | undefined;
  return target
    ? { outcome: result[0].results.length ? "committed" : "no_op", target }
    : { outcome: "conflict" };
}
