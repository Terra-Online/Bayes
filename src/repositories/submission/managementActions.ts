import type { SnapshotReviewStatus } from "./snapshotReads";
import type { SubmissionKind } from "./types";

interface ManagementCommand {
  submissionId: string;
  snapshotId: string;
  adminUserId: string;
}
interface ManagementTarget {
  kind: SubmissionKind;
  markerId: string;
  userId: string;
  role: string | null;
  reviewStatus: SnapshotReviewStatus;
  hasEarlierApproval: boolean;
  authorDeletedAt: string | null;
}
export type ManagementResult =
  | { outcome: "conflict" }
  | { outcome: "committed" | "no_op"; target: ManagementTarget };

const admin = `EXISTS (SELECT 1 FROM users WHERE uid=?3 AND role IN ('p','a','r'))`;
const targetSelection = `SELECT s.kind,s.poi_id AS markerId,s.user_id AS userId,u.role,
  f.review_status AS reviewStatus,s.author_deleted_at AS authorDeletedAt,
  EXISTS (SELECT 1 FROM ugc_snapshots earlier WHERE earlier.submission_id=s.id
    AND earlier.revision<f.revision AND earlier.review_status='approved') AS hasEarlierApproval
  FROM ugc_submissions s JOIN ugc_submission_visibility v ON v.submission_id=s.id
  JOIN ugc_snapshots f ON f.id=v.frontier_snapshot_id
  LEFT JOIN users u ON u.uid=s.user_id WHERE s.id=?1 AND ${admin}`;

/** First facts and exact frontier eligibility are checked inside the same batch.
 * A no-op is returned only for an eligible repeat, never for a stale target.
 */
export async function disableSubmission(
  db: D1Database,
  input: ManagementCommand,
): Promise<ManagementResult> {
  const eligibility = `EXISTS (SELECT 1 FROM ugc_submission_visibility v
    WHERE v.submission_id=s.id AND v.frontier_snapshot_id=?2)`;
  const result = await db.batch([
    db
      .prepare(`UPDATE ugc_submissions AS s
      SET admin_deleted_at=?4,admin_deleted_by=?3,updated_at=?4
      WHERE s.id=?1 AND s.admin_deleted_at IS NULL AND ${admin} AND ${eligibility}
      RETURNING id`)
      .bind(input.submissionId, input.snapshotId, input.adminUserId, new Date().toISOString()),
    db
      .prepare(`${targetSelection} AND v.frontier_snapshot_id=?2`)
      .bind(input.submissionId, input.snapshotId, input.adminUserId),
  ]);
  const target = result[1].results[0] as ManagementTarget | undefined;
  return target
    ? {
        outcome: result[0].results.length ? "committed" : "no_op",
        target: { ...target, hasEarlierApproval: Boolean(target.hasEarlierApproval) },
      }
    : { outcome: "conflict" };
}

/** Report target is public when available, otherwise frontier, including hidden
 * records. Clearing is independent of review, deletion, notifications and points.
 */
export async function clearSubmissionFlags(
  db: D1Database,
  input: ManagementCommand,
): Promise<ManagementResult> {
  const eligibility = `COALESCE(v.public_snapshot_id,v.frontier_snapshot_id)=?2`;
  const result = await db.batch([
    db
      .prepare(`UPDATE ugc_submission_flags SET active=0
      WHERE submission_id=?1 AND active=1 AND ${admin}
      AND EXISTS (SELECT 1 FROM ugc_submission_visibility v
        WHERE v.submission_id=?1 AND ${eligibility}) RETURNING submission_id`)
      .bind(input.submissionId, input.snapshotId, input.adminUserId),
    db
      .prepare(`${targetSelection} AND ${eligibility}`)
      .bind(input.submissionId, input.snapshotId, input.adminUserId),
  ]);
  const target = result[1].results[0] as ManagementTarget | undefined;
  return target
    ? {
        outcome: result[0].results.length ? "committed" : "no_op",
        target: { ...target, hasEarlierApproval: Boolean(target.hasEarlierApproval) },
      }
    : { outcome: "conflict" };
}
