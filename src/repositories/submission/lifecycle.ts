import type { SubmissionKind } from "./types";

interface LifecycleInput {
  submissionId: string;
  actorId: string;
  action: "deleted" | "restored";
  permission: "owner" | "reviewer" | "admin";
  kind?: SubmissionKind;
  snapshotId?: string;
  expectedLifecycleVersion?: number;
  note?: string;
  initialDeletionOnly?: boolean;
}
export interface LifecycleState {
  kind: SubmissionKind;
  markerId: string;
  userId: string;
  deletedAt: string | null;
  deletedBy: string | null;
  lifecycleVersion: number;
}
export type LifecycleResult =
  | { outcome: "committed" | "no_op"; target: LifecycleState }
  | { outcome: "missing" }
  | { outcome: "forbidden" }
  | { outcome: "conflict" };

/** The conditional audit receipt and lifecycle write are one transaction. */
export async function changeSubmissionDeletion(
  db: D1Database,
  input: LifecycleInput,
): Promise<LifecycleResult> {
  const auditId = crypto.randomUUID();
  const now = new Date().toISOString();
  const roles = input.permission === "reviewer" ? "'p','a','r'" : "'a','r'";
  const authorized =
    input.permission === "owner"
      ? "s.user_id=?2"
      : `EXISTS (SELECT 1 FROM users WHERE id=?2 AND role IN (${roles}))`;
  const eligible = `${authorized} AND (?3 IS NULL OR s.kind=?3)
    AND (?4 IS NULL OR EXISTS (SELECT 1 FROM ugc_snapshots f
      WHERE f.submission_id=s.id AND f.revision=s.revision AND f.id=?4))
    AND (?5 IS NULL OR s.lifecycle_version=?5)
    ${input.initialDeletionOnly ? "AND (s.lifecycle_version=0 OR s.deleted_at IS NOT NULL)" : ""}`;
  const args = [
    input.submissionId,
    input.actorId,
    input.kind ?? null,
    input.snapshotId ?? null,
    input.expectedLifecycleVersion ?? null,
  ];
  const result = await db.batch([
    db
      .prepare(`SELECT s.kind,s.poi_id AS markerId,s.user_id AS userId,
      s.deleted_at AS deletedAt,s.deleted_by AS deletedBy,s.lifecycle_version AS lifecycleVersion,
      (${authorized}) AS authorized,(${eligible}) AS eligible
      FROM ugc_submissions s WHERE s.id=?1 AND (?3 IS NULL OR s.kind=?3)`)
      .bind(...args),
    db
      .prepare(`INSERT INTO ugc_submission_audit
      (id,submission_id,action,actor_user_id,deleted_at,deleted_by,lifecycle_version,note,created_at)
      SELECT ?6,s.id,?7,?2,
        CASE WHEN ?7='deleted' THEN ?8 ELSE s.deleted_at END,
        CASE WHEN ?7='deleted' THEN ?2 ELSE s.deleted_by END,
        s.lifecycle_version+1,?9,?8 FROM ugc_submissions s
      WHERE s.id=?1 AND ${eligible}
        AND ((?7='deleted' AND s.deleted_at IS NULL) OR (?7='restored' AND s.deleted_at IS NOT NULL))`)
      .bind(...args, auditId, input.action, now, input.note ?? null),
    db
      .prepare(`UPDATE ugc_submissions SET
      deleted_at=CASE WHEN ?2='deleted' THEN ?3 ELSE NULL END,
      deleted_by=CASE WHEN ?2='deleted' THEN ?4 ELSE NULL END,
      lifecycle_version=lifecycle_version+1,updated_at=?3
      WHERE id=?5 AND EXISTS (SELECT 1 FROM ugc_submission_audit WHERE id=?1)
      RETURNING kind,poi_id AS markerId,user_id AS userId,deleted_at AS deletedAt,
        deleted_by AS deletedBy,lifecycle_version AS lifecycleVersion`)
      .bind(auditId, input.action, now, input.actorId, input.submissionId),
  ]);
  const before = result[0].results[0] as
    | (LifecycleState & { authorized: number; eligible: number })
    | undefined;
  if (!before) {
    return { outcome: "missing" };
  }
  if (!before.authorized) {
    return { outcome: "forbidden" };
  }
  if (!before.eligible) {
    return { outcome: "conflict" };
  }
  const target = result[2].results[0] as LifecycleState | undefined;
  const state: LifecycleState = {
    kind: before.kind,
    markerId: before.markerId,
    userId: before.userId,
    deletedAt: before.deletedAt,
    deletedBy: before.deletedBy,
    lifecycleVersion: before.lifecycleVersion,
  };
  return { outcome: target ? "committed" : "no_op", target: target ?? state };
}
