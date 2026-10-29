import type { NotificationRecord } from "@/repositories/notifications";
import { formatPublicUid } from "@/repositories/users";

import { commitReviewBatch } from "./reviewNotifications";
import type { SnapshotReviewStatus } from "./snapshotReads";
import type { SubmissionRecord } from "./types";

/** A real immutable version, without legacy edit backups or inferred review notes. */
export type ReviewTarget = Pick<
  SubmissionRecord,
  | "id"
  | "snapshotId"
  | "kind"
  | "markerId"
  | "poiHash"
  | "poiType"
  | "userId"
  | "content"
  | "filePath"
  | "mimeType"
  | "sizeBytes"
  | "parentId"
  | "commentDepth"
  | "createdAt"
  | "updatedAt"
  | "submitter"
> & { reviewStatus: SnapshotReviewStatus; hasEarlierApproval: boolean };

export type ReviewCommand = {
  target: ReviewTarget;
  expectedReviewStatus: SnapshotReviewStatus;
  /** Fresh service-generated identity for this attempt, never a client operation ID. */
  auditId: string;
  note?: string;
} & (
  | { source: "ai"; decision: "approved" | "pending_audit" }
  | { source: "admin"; adminUserId: string; decision: "approved" | "rejected" | "pending_audit" }
);

export type ReviewResult =
  | { outcome: "ignored" }
  | {
      outcome: "committed";
      target: ReviewTarget;
      reviewStatus: ReviewCommand["decision"];
      firstApproval: boolean;
      publicReplaced: boolean;
      notifications: NotificationRecord[];
    };

export async function getReviewTarget(
  db: D1Database,
  submissionId: string,
  snapshotId?: string,
): Promise<ReviewTarget | null> {
  const row = await db
    .prepare(`SELECT
    s.id, s.kind, s.poi_id AS markerId, s.poi_hash AS poiHash, s.poi_type AS poiType,
    s.user_id AS userId, s.parent_id AS parentId, s.comment_depth AS commentDepth,
    s.created_at AS createdAt, s.updated_at AS updatedAt,
    f.id AS snapshotId, f.content, f.file_path AS filePath, f.mime_type AS mimeType,
    f.size_bytes AS sizeBytes, f.review_status AS reviewStatus,
    EXISTS (SELECT 1 FROM ugc_snapshots earlier WHERE earlier.submission_id=s.id
      AND earlier.revision<f.revision AND earlier.review_status='approved') AS hasEarlierApproval,
    u.uid, u.uid_number AS uidNumber, u.uid_suffix AS uidSuffix,
    u.role, u.karma, u.nickname, u.avt AS avatar
    FROM ugc_submissions s JOIN ugc_snapshots f
      ON f.submission_id=s.id AND f.revision=s.revision
    LEFT JOIN users u ON u.uid=s.user_id
    WHERE s.id=?1 AND (?2 IS NULL OR f.id=?2)
      AND s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL`)
    .bind(submissionId, snapshotId ?? null)
    .first<
      Omit<ReviewTarget, "submitter"> & {
        uid: string | null;
        uidNumber: number | null;
        uidSuffix: string | null;
        role: string | null;
        karma: number | null;
        nickname: string | null;
        avatar: number | null;
      }
    >();
  if (!row) {
    return null;
  }
  const { uid, uidNumber, uidSuffix, role, karma, nickname, avatar, ...target } = row;
  return {
    ...target,
    hasEarlierApproval: Boolean(target.hasEarlierApproval),
    submitter: uid
      ? {
          uid,
          uidNumber,
          publicUid: uidNumber !== null && uidSuffix ? formatPublicUid(uidNumber, uidSuffix) : null,
          role,
          karma,
          nickname,
          avatar,
        }
      : null,
  };
}

/** Automatic work never calls AI for a terminal or manually taken-over version. */
export async function getAutomaticReviewTarget(
  db: D1Database,
  submissionId: string,
  snapshotId?: string,
): Promise<ReviewTarget | null> {
  const target = await getReviewTarget(db, submissionId, snapshotId);
  return target?.reviewStatus === "pending_openai" ? target : null;
}

/** The fresh conditional audit INSERT is the sole success receipt for this batch.
 * The UNION collision branch deliberately raises a PK error even if eligibility
 * was lost: an old receipt must never authorize this attempt's following writes.
 */
export async function reviewSnapshot(
  db: D1Database,
  command: ReviewCommand,
): Promise<ReviewResult> {
  const { target, auditId, expectedReviewStatus, decision, source } = command;
  const now = new Date().toISOString();
  const receipt = `EXISTS (SELECT 1 FROM ugc_snapshots_review_audit WHERE id=?1)`;
  const statements = [
    db
      .prepare(`INSERT INTO ugc_snapshots_review_audit
      (id,snapshot_id,from_status,to_status,source,admin_user_id,note,created_at)
      SELECT ?1,f.id,f.review_status,?5,?6,?7,?8,?9
      FROM ugc_submissions s JOIN ugc_snapshots f
        ON f.submission_id=s.id AND f.revision=s.revision
      WHERE s.id=?2 AND f.id=?3 AND f.review_status=?4
        AND s.author_deleted_at IS NULL AND s.admin_deleted_at IS NULL
        AND ((?6='ai' AND ?7 IS NULL AND ?4='pending_openai' AND ?5 IN ('approved','pending_audit'))
          OR (?6='admin' AND EXISTS (SELECT 1 FROM users WHERE uid=?7 AND role IN ('p','a','r'))
            AND ((?4='pending_openai' AND ?5 IN ('approved','rejected','pending_audit'))
              OR (?4='pending_audit' AND ?5 IN ('approved','rejected')))))
      UNION ALL
      SELECT id,snapshot_id,from_status,to_status,source,admin_user_id,note,created_at
      FROM ugc_snapshots_review_audit WHERE id=?1
      RETURNING id`)
      .bind(
        auditId,
        target.id,
        target.snapshotId,
        expectedReviewStatus,
        decision,
        source,
        source === "admin" ? command.adminUserId : null,
        command.note ?? null,
        now,
      ),
    db
      .prepare(`UPDATE ugc_snapshots SET review_status=?3
      WHERE id=?2 AND ${receipt}`)
      .bind(auditId, target.snapshotId, decision),
    db
      .prepare(`UPDATE ugc_submission_flags SET active=0
      WHERE submission_id=?2 AND active=1 AND ?4='approved' AND ${receipt}
        AND EXISTS (SELECT 1 FROM ugc_snapshots f JOIN ugc_snapshots p
          ON p.submission_id=f.submission_id AND p.revision=f.revision-1
          WHERE f.id=?3 AND p.review_status='approved')`)
      .bind(auditId, target.id, target.snapshotId, decision),
    db
      .prepare(`SELECT
      (?4='approved' AND NOT EXISTS (SELECT 1 FROM ugc_snapshots p
        WHERE p.submission_id=?2 AND p.review_status='approved'
          AND p.revision < (SELECT revision FROM ugc_snapshots WHERE id=?3))) AS firstApproval,
      (?4='approved' AND EXISTS (SELECT 1 FROM ugc_snapshots f JOIN ugc_snapshots p
        ON p.submission_id=f.submission_id AND p.revision=f.revision-1
        WHERE f.id=?3 AND p.review_status='approved')) AS publicReplaced
      WHERE ${receipt}`)
      .bind(auditId, target.id, target.snapshotId, decision),
  ];
  const result = await commitReviewBatch(db, command, statements, now);
  return result.committed
    ? {
        outcome: "committed",
        target,
        reviewStatus: decision,
        firstApproval: result.firstApproval,
        publicReplaced: result.publicReplaced,
        notifications: result.notifications,
      }
    : { outcome: "ignored" };
}
